const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseEpisode,
  loadEpisode,
  parseSceneSelection,
  getPendingScenes,
  getDownloadedScenePaths,
} = require("../src/flow-episode");
const { buildStitchArgs } = require("../src/episode-stitcher");

const projectRoot = path.resolve(__dirname, "..");

function sampleEpisode() {
  return {
    id: "ep-test",
    title: "Test",
    character: "Pip, a cloud",
    style: "Soft 3D.",
    scenes: [
      { name: "One", prompt: "{character} waves. {style}" },
      { name: "Two", prompt: "{character}   floats.\n{style}" },
      { prompt: "Just a sky." },
    ],
  };
}

test("parseEpisode fills character and style into every scene prompt", () => {
  const episode = parseEpisode(sampleEpisode());
  assert.equal(episode.scenes.length, 3);
  assert.equal(episode.scenes[0].prompt, "Pip, a cloud waves. Soft 3D.");
  assert.equal(episode.scenes[1].prompt, "Pip, a cloud floats. Soft 3D.");
  assert.equal(episode.scenes[2].name, "Scene 3");
  assert.deepEqual(
    episode.scenes.map((scene) => scene.fileName),
    ["scene-01.mp4", "scene-02.mp4", "scene-03.mp4"]
  );
});

test("parseEpisode rejects bad ids, empty scenes and unknown placeholders", () => {
  assert.throws(() => parseEpisode({ ...sampleEpisode(), id: "Bad Id" }), /id/);
  assert.throws(() => parseEpisode({ ...sampleEpisode(), scenes: [] }), /scenes/);
  assert.throws(
    () => parseEpisode({ ...sampleEpisode(), scenes: [{ prompt: "{villain} appears" }] }),
    /\{villain\}/
  );
  assert.throws(() => parseEpisode({ ...sampleEpisode(), scenes: [{ name: "x" }] }), /prompt/);
});

test("bundled Pip episode file is valid", async () => {
  const episode = await loadEpisode(
    path.join(projectRoot, "content/kids-shorts/ep01-pip-rainbow-colors.flow.json")
  );
  assert.equal(episode.id, "ep01-pip-rainbow-colors");
  assert.equal(episode.scenes.length, 9);
  for (const scene of episode.scenes) {
    assert.match(scene.prompt, /^Pip, a small round fluffy white cloud/);
    assert.match(scene.prompt, /No dialogue/);
  }
});

test("parseSceneSelection supports single numbers, lists and ranges", () => {
  assert.equal(parseSceneSelection(undefined, 9), null);
  assert.equal(parseSceneSelection("", 9), null);
  assert.deepEqual([...parseSceneSelection("3", 9)], [3]);
  assert.deepEqual([...parseSceneSelection("1, 4", 9)].sort(), [1, 4]);
  assert.deepEqual([...parseSceneSelection("2-4,7", 9)].sort(), [2, 3, 4, 7]);
  assert.throws(() => parseSceneSelection("0", 9), /outside/);
  assert.throws(() => parseSceneSelection("8-10", 9), /outside/);
  assert.throws(() => parseSceneSelection("abc", 9), /Invalid/);
});

test("getPendingScenes skips downloaded clips unless forced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autosocial-episode-"));
  try {
    const episode = parseEpisode(sampleEpisode());
    fs.writeFileSync(path.join(dir, "scene-01.mp4"), "video");
    fs.writeFileSync(path.join(dir, "scene-02.mp4"), "");

    const pending = await getPendingScenes(episode, dir);
    assert.deepEqual(pending.map((scene) => scene.number), [2, 3]);

    const selected = await getPendingScenes(episode, dir, { selection: new Set([1, 3]) });
    assert.deepEqual(selected.map((scene) => scene.number), [3]);

    const forced = await getPendingScenes(episode, dir, { force: true });
    assert.deepEqual(forced.map((scene) => scene.number), [1, 2, 3]);

    const { found, missing } = await getDownloadedScenePaths(episode, dir);
    assert.deepEqual(found, [path.join(dir, "scene-01.mp4")]);
    assert.deepEqual(missing.map((scene) => scene.number), [2, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStitchArgs joins clips in order at 1080x1920", () => {
  const args = buildStitchArgs(["a.mp4", "b.mp4"], "out.mp4");
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.deepEqual(args.slice(0, 5), ["-y", "-i", "a.mp4", "-i", "b.mp4"]);
  assert.match(filter, /\[0:v\]scale=1080:1920/);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[outv\]\[outa\]/);
  assert.ok(args.includes("[outa]"));
  assert.equal(args[args.length - 1], "out.mp4");

  const silent = buildStitchArgs(["a.mp4"], "out.mp4", { withAudio: false });
  const silentFilter = silent[silent.indexOf("-filter_complex") + 1];
  assert.match(silentFilter, /concat=n=1:v=1:a=0\[outv\]$/);
  assert.ok(silent.includes("-an"));
  assert.ok(!silentFilter.includes("[0:a]"));

  assert.throws(() => buildStitchArgs([], "out.mp4"), /No clips/);
});
