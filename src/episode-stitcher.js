const fs = require("fs/promises");
const path = require("path");
const { runFfmpeg, getVideoInfo } = require("./video-uniquifier");

const SHORTS_WIDTH = 1080;
const SHORTS_HEIGHT = 1920;
const SHORTS_FPS = 30;

// Builds ffmpeg args that scale/pad every clip to 1080x1920 and join them in order.
function buildStitchArgs(inputPaths, outputPath, { withAudio = true } = {}) {
  if (!inputPaths.length) {
    throw new Error("No clips to stitch.");
  }
  const args = ["-y"];
  for (const input of inputPaths) {
    args.push("-i", input);
  }

  const filters = [];
  const concatInputs = [];
  inputPaths.forEach((_, i) => {
    filters.push(
      `[${i}:v]scale=${SHORTS_WIDTH}:${SHORTS_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${SHORTS_WIDTH}:${SHORTS_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=white,` +
        `setsar=1,fps=${SHORTS_FPS},format=yuv420p[v${i}]`
    );
    concatInputs.push(`[v${i}]`);
    if (withAudio) {
      filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });
  const audioFlag = withAudio ? 1 : 0;
  const outputs = withAudio ? "[outv][outa]" : "[outv]";
  filters.push(`${concatInputs.join("")}concat=n=${inputPaths.length}:v=1:a=${audioFlag}${outputs}`);

  args.push("-filter_complex", filters.join(";"), "-map", "[outv]");
  if (withAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-movflags", "+faststart",
    outputPath
  );
  return args;
}

async function hasAudioStream(filePath) {
  const info = await getVideoInfo(filePath);
  return (info.streams || []).some((stream) => stream.codec_type === "audio");
}

// Joins scene clips into one vertical Short. Audio is kept only when every clip has it.
async function stitchClips(inputPaths, outputPath, { mute = false } = {}) {
  let withAudio = !mute;
  if (withAudio) {
    for (const input of inputPaths) {
      if (!(await hasAudioStream(input))) {
        withAudio = false;
        break;
      }
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(buildStitchArgs(inputPaths, outputPath, { withAudio }));
  return { outputPath, withAudio };
}

module.exports = {
  buildStitchArgs,
  stitchClips,
};
