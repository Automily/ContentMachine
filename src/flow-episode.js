const fs = require("fs/promises");
const path = require("path");

const EPISODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fillPlaceholders(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

function sceneFileName(index) {
  return `scene-${String(index + 1).padStart(2, "0")}.mp4`;
}

function parseEpisode(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Episode file must contain a JSON object.");
  }
  const id = String(raw.id || "").trim();
  if (!EPISODE_ID_PATTERN.test(id)) {
    throw new Error('Episode "id" must use lowercase letters, numbers and dashes only.');
  }
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error('Episode needs a non-empty "scenes" array.');
  }

  const values = {
    character: String(raw.character || "").trim(),
    style: String(raw.style || "").trim(),
  };

  const scenes = raw.scenes.map((scene, index) => {
    const template = String((scene && scene.prompt) || "").trim();
    if (!template) {
      throw new Error(`Scene ${index + 1} is missing a "prompt".`);
    }
    const prompt = fillPlaceholders(template, values).replace(/\s+/g, " ").trim();
    const unresolved = prompt.match(/\{(\w+)\}/);
    if (unresolved) {
      throw new Error(`Scene ${index + 1} uses unknown placeholder ${unresolved[0]}.`);
    }
    return {
      number: index + 1,
      name: String(scene.name || `Scene ${index + 1}`),
      prompt,
      fileName: sceneFileName(index),
    };
  });

  return {
    id,
    title: String(raw.title || id),
    description: String(raw.description || ""),
    scenes,
  };
}

async function loadEpisode(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse episode file ${filePath}: ${error.message}`);
  }
  return parseEpisode(raw);
}

// Accepts "3", "1,4", "2-5" or "1-3,7". Returns a Set of 1-based scene numbers.
function parseSceneSelection(value, sceneCount) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const selected = new Set();
  for (const part of String(value).split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = trimmed.match(/^(\d+)$/);
    let start;
    let end;
    if (range) {
      start = Number(range[1]);
      end = Number(range[2]);
    } else if (single) {
      start = Number(single[1]);
      end = start;
    } else {
      throw new Error(`Invalid scene selection "${trimmed}". Use forms like 3, 1,4 or 2-5.`);
    }
    if (start < 1 || end > sceneCount || start > end) {
      throw new Error(`Scene selection "${trimmed}" is outside 1-${sceneCount}.`);
    }
    for (let n = start; n <= end; n += 1) selected.add(n);
  }
  return selected;
}

async function fileHasContent(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// Scenes still to generate: selected (or all) scenes without a downloaded clip,
// unless force is set.
async function getPendingScenes(episode, outputDir, { selection = null, force = false } = {}) {
  const pending = [];
  for (const scene of episode.scenes) {
    if (selection && !selection.has(scene.number)) continue;
    if (!force && (await fileHasContent(path.join(outputDir, scene.fileName)))) continue;
    pending.push(scene);
  }
  return pending;
}

async function getDownloadedScenePaths(episode, outputDir) {
  const found = [];
  const missing = [];
  for (const scene of episode.scenes) {
    const scenePath = path.join(outputDir, scene.fileName);
    if (await fileHasContent(scenePath)) {
      found.push(scenePath);
    } else {
      missing.push(scene);
    }
  }
  return { found, missing };
}

module.exports = {
  parseEpisode,
  loadEpisode,
  parseSceneSelection,
  getPendingScenes,
  getDownloadedScenePaths,
  sceneFileName,
};
