const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { config } = require("./config");

// Google Flow has no public API, so this drives the Flow web app with the same
// persistent-browser approach the uploaders use. Selectors are text/role based
// so small UI changes do not break them, and every failure leaves a screenshot.

const CREDIT_PATTERN =
  /not enough credits|out of credits|insufficient credits|run out of credits|no credits (left|remaining)|daily (generation )?limit|credit limit reached/i;
const GENERATION_ERROR_PATTERN =
  /(couldn't|could not|unable to) generate|failed to generate|generation failed|violates? (our|the) (policies|policy)|against our policies|try a different prompt|something went wrong/i;
const LOGIN_URL_PATTERN = /accounts\.google\.com|\/signin|\/login/i;
const MIN_CLIP_BYTES = 10 * 1024;

function log(onLog, message) {
  (onLog || console.log)(message);
}

async function openFlowContext({ headless = config.headless } = {}) {
  await fs.mkdir(config.flowProfileDir, { recursive: true });
  return chromium.launchPersistentContext(config.flowProfileDir, {
    headless,
    acceptDownloads: true,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

// Opens Flow in a visible browser so the user can sign in to Google once.
// Resolves when the user closes the browser window.
async function runFlowLogin({ onLog } = {}) {
  const context = await openFlowContext({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(config.flowUrl, { waitUntil: "domcontentloaded" });
  log(onLog, "Sign in to Google Flow in the browser window, then close the window to save the session.");
  await new Promise((resolve) => context.on("close", resolve));
  log(onLog, `Flow session saved to ${config.flowProfileDir}`);
}

async function firstUsable(locator) {
  const total = await locator.count().catch(() => 0);
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (await candidate.isDisabled().catch(() => false)) continue;
    return candidate;
  }
  return null;
}

async function findPromptBox(page) {
  const candidates = [
    page.locator("textarea"),
    page.getByRole("textbox"),
    page.locator('[contenteditable="true"]'),
  ];
  for (const locator of candidates) {
    const found = await firstUsable(locator);
    if (found) return found;
  }
  return null;
}

async function waitForPromptBox(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = await findPromptBox(page);
    if (box) return box;
    await page.waitForTimeout(1000);
  }
  return null;
}

function assertNotOnLoginPage(page) {
  if (LOGIN_URL_PATTERN.test(page.url())) {
    throw new Error('Not signed in to Google Flow. Run "npm run flow:login" first.');
  }
}

// Gets the page to a Flow project with a prompt box: either the saved
// FLOW_PROJECT_URL or a new project created from the Flow home page.
async function openProject(page, { onLog } = {}) {
  const target = config.flowProjectUrl || config.flowUrl;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  assertNotOnLoginPage(page);

  let box = await waitForPromptBox(page, 5000);
  const entryButtons = [/new project/i, /create with flow/i, /get started/i];
  for (let round = 0; !box && round < 3; round += 1) {
    for (const name of entryButtons) {
      const button = await firstUsable(
        page.getByRole("button", { name }).or(page.getByRole("link", { name }))
      );
      if (!button) continue;
      await button.click().catch(() => {});
      await page.waitForTimeout(2500);
      assertNotOnLoginPage(page);
      break;
    }
    box = await waitForPromptBox(page, 8000);
  }

  if (!box) {
    throw new Error(
      "Could not find the Flow prompt box. Check you are signed in (npm run flow:login), " +
        "or open a Flow project yourself and set FLOW_PROJECT_URL in .env."
    );
  }
  if (!config.flowProjectUrl) {
    log(onLog, `Using Flow project: ${page.url()}`);
    log(onLog, "Tip: set FLOW_PROJECT_URL to this URL in .env to reuse the project and its settings.");
  }
  return box;
}

async function listVideoSources(page) {
  return page.$$eval("video", (videos) => {
    const sources = [];
    for (const video of videos) {
      const candidates = [video.currentSrc, video.src];
      for (const source of video.querySelectorAll("source")) {
        candidates.push(source.src);
      }
      const found = candidates.find((value) => value && value.length > 0);
      if (found) sources.push(found);
    }
    return sources;
  });
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return (String(text || "").match(new RegExp(pattern.source, flags)) || []).length;
}

async function readBodyText(page) {
  return (await page.locator("body").innerText().catch(() => "")) || "";
}

async function readPromptValue(box) {
  return box
    .evaluate((el) => ("value" in el ? el.value : el.textContent) || "")
    .catch(() => "");
}

async function submitPrompt(page, box, prompt) {
  await box.click();
  await box.fill(prompt);
  await page.waitForTimeout(400);

  const container = box.locator("xpath=ancestor::*[.//button][1]");
  const submitButton =
    (await firstUsable(
      container.getByRole("button", { name: /^(create|generate|send|submit)\b/i })
    )) ||
    (await firstUsable(
      page.getByRole("button", { name: /^(create|generate|send|submit)\b/i })
    ));
  if (submitButton) {
    await submitButton.click().catch(() => {});
  } else {
    await box.press("Enter");
  }
  await page.waitForTimeout(3000);

  // If the prompt is still sitting in the box, the click did not submit.
  const remaining = (await readPromptValue(box)).trim();
  if (remaining && remaining === prompt.trim()) {
    await box.press("Enter").catch(() => {});
    await page.waitForTimeout(2000);
  }
}

async function waitForNewVideo(page, knownSources, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await readBodyText(page);
    if (countMatches(body, CREDIT_PATTERN) > baseline.credit) {
      const error = new Error("Flow reports you are out of credits.");
      error.outOfCredits = true;
      throw error;
    }
    if (countMatches(body, GENERATION_ERROR_PATTERN) > baseline.generation) {
      throw new Error("Flow could not generate this scene (it may have been blocked by a content filter).");
    }

    const sources = await listVideoSources(page);
    const fresh = sources.find((source) => !knownSources.has(source));
    if (fresh) return fresh;
    await page.waitForTimeout(5000);
  }
  throw new Error(`No finished video appeared within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function fetchVideoBytes(page, source) {
  if (source.startsWith("blob:") || source.startsWith("data:")) {
    const base64 = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(new Error("Could not read video blob."));
        reader.readAsDataURL(blob);
      });
    }, source);
    return Buffer.from(base64, "base64");
  }

  const response = await page.context().request.get(source, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`Video download failed with HTTP ${response.status()}.`);
  }
  return response.body();
}

async function saveClip(buffer, destPath) {
  if (buffer.length < MIN_CLIP_BYTES) {
    throw new Error(`Downloaded clip is only ${buffer.length} bytes; expected a video file.`);
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.part`;
  await fs.writeFile(tempPath, buffer);
  await fs.rename(tempPath, destPath);
}

async function generateScene(page, scene, outputDir) {
  const box = await findPromptBox(page);
  if (!box) {
    throw new Error("Flow prompt box disappeared.");
  }

  const knownSources = new Set(await listVideoSources(page));
  const bodyBefore = await readBodyText(page);
  const baseline = {
    credit: countMatches(bodyBefore, CREDIT_PATTERN),
    generation: countMatches(bodyBefore, GENERATION_ERROR_PATTERN),
  };

  await submitPrompt(page, box, scene.prompt);
  const source = await waitForNewVideo(page, knownSources, baseline, config.flowGenerationTimeoutMs);
  // Give Flow a moment to finish writing the clip before downloading it.
  await page.waitForTimeout(3000);
  const buffer = await fetchVideoBytes(page, source);
  const destPath = path.join(outputDir, scene.fileName);
  await saveClip(buffer, destPath);
  return destPath;
}

// Generates each scene in order and saves it as outputDir/scene-NN.mp4.
// Stops early when Flow runs out of credits; already-saved scenes are kept,
// so re-running continues where it left off.
async function generateScenes({ scenes, outputDir, onLog }) {
  const result = { generated: [], failed: [], stoppedReason: null };
  if (!scenes.length) return result;

  const context = await openFlowContext();
  const page = context.pages()[0] || (await context.newPage());
  try {
    await openProject(page, { onLog });

    for (const scene of scenes) {
      log(onLog, `Scene ${scene.number} (${scene.name}): generating...`);
      try {
        const savedPath = await generateScene(page, scene, outputDir);
        result.generated.push({ scene, path: savedPath });
        log(onLog, `Scene ${scene.number}: saved ${savedPath}`);
      } catch (error) {
        const screenshotPath = path.resolve(
          config.projectRoot,
          `last-flow-error-scene-${String(scene.number).padStart(2, "0")}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        result.failed.push({ scene, error: error.message, screenshotPath });
        log(onLog, `Scene ${scene.number}: FAILED - ${error.message} (screenshot: ${screenshotPath})`);
        if (error.outOfCredits) {
          result.stoppedReason = "Out of Flow credits. Re-run later to continue with the remaining scenes.";
          break;
        }
      }
      await page.waitForTimeout(2000);
    }
  } catch (error) {
    const screenshotPath = path.resolve(config.projectRoot, "last-flow-error.png");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    result.stoppedReason = `${error.message} (screenshot: ${screenshotPath})`;
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

module.exports = {
  runFlowLogin,
  generateScenes,
  // Exported for tests.
  CREDIT_PATTERN,
  GENERATION_ERROR_PATTERN,
  countMatches,
};
