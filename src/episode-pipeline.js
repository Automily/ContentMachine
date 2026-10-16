const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const {
  loadEpisode,
  parseSceneSelection,
  getPendingScenes,
  getDownloadedScenePaths,
} = require("./flow-episode");
const { stitchClips } = require("./episode-stitcher");

function getEpisodeOutputDir(episode) {
  return path.join(config.flowOutputDir, episode.id);
}

async function writeUploadDetails(episode, outputDir) {
  const detailsPath = path.join(outputDir, "upload-details.txt");
  const lines = [episode.title, "", episode.description || ""];
  await fs.writeFile(detailsPath, `${lines.join("\n").trim()}\n`, "utf8");
  return detailsPath;
}

// Joins the downloaded scene clips into outputDir/<episode-id>.mp4.
async function stitchEpisode({ episodeFile, mute = false, onLog = console.log }) {
  const episode = await loadEpisode(episodeFile);
  const outputDir = getEpisodeOutputDir(episode);
  const { found, missing } = await getDownloadedScenePaths(episode, outputDir);
  if (missing.length) {
    const names = missing.map((scene) => scene.number).join(", ");
    return {
      ok: false,
      error: `Missing clips for scene(s) ${names}. Generate them first with flow-generate.`,
    };
  }

  const finalPath = path.join(outputDir, `${episode.id}.mp4`);
  onLog(`Stitching ${found.length} clips...`);
  const { withAudio } = await stitchClips(found, finalPath, { mute });
  const detailsPath = await writeUploadDetails(episode, outputDir);
  return { ok: true, finalPath, detailsPath, withAudio };
}

// Generates any scenes that are not downloaded yet, then stitches the episode
// once every scene clip exists.
async function produceEpisode({
  episodeFile,
  scenes: sceneSelection,
  force = false,
  stitch = true,
  mute = false,
  onLog = console.log,
}) {
  // Required lazily so stitching and tests do not need Playwright loaded.
  const { generateScenes } = require("./flow-generator");

  const episode = await loadEpisode(episodeFile);
  const outputDir = getEpisodeOutputDir(episode);
  await fs.mkdir(outputDir, { recursive: true });

  const selection = parseSceneSelection(sceneSelection, episode.scenes.length);
  const pending = await getPendingScenes(episode, outputDir, { selection, force });
  onLog(`Episode ${episode.id}: ${episode.scenes.length} scenes, ${pending.length} to generate.`);
  onLog(`Clips folder: ${outputDir}`);

  const generation = await generateScenes({ scenes: pending, outputDir, onLog });

  const { missing } = await getDownloadedScenePaths(episode, outputDir);
  const summary = {
    episode,
    outputDir,
    generated: generation.generated,
    failed: generation.failed,
    stoppedReason: generation.stoppedReason,
    missing,
    stitched: null,
  };

  if (stitch && missing.length === 0) {
    summary.stitched = await stitchEpisode({ episodeFile, mute, onLog });
  }
  return summary;
}

module.exports = {
  produceEpisode,
  stitchEpisode,
  getEpisodeOutputDir,
};
