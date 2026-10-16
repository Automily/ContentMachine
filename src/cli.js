#!/usr/bin/env node
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { startLoginSession } = require("./tiktok-uploader");
const { postNextFromQueue, postFromManualInput } = require("./post-service");
const { startDaemon, runScheduledPost } = require("./scheduler");
const { config } = require("./config");
const { ensureDirectories } = require("./fs-utils");
const { runFlowLogin } = require("./flow-generator");
const { produceEpisode, stitchEpisode } = require("./episode-pipeline");
const { uniquifyVideo, uniquifyInPlace, uniquifyDirectory, checkFfmpeg, getVideoInfo } = require("./video-uniquifier");

async function bootstrap() {
  await ensureDirectories([
    config.queueDir,
    config.postedDir,
    config.failedDir,
    config.profileDir,
  ]);
}

function logResult(result) {
  if (result.skipped) {
    console.log(result.reason);
    return;
  }

  if (result.ok) {
    console.log("Post complete.");
    console.log(`Moved video: ${result.movedVideo}`);
    return;
  }

  console.error("Post failed.");
  console.error(result.error);
  if (result.screenshotPath) {
    console.error(`Screenshot: ${result.screenshotPath}`);
  }
}

async function ensureFfmpegForStitch(needed) {
  if (!needed) return;
  if (!(await checkFfmpeg())) {
    console.error("ffmpeg is not installed or not in PATH (needed to stitch the episode).");
    console.error("Install it from https://ffmpeg.org/download.html or pass --no-stitch.");
    process.exit(1);
  }
}

function logStitchResult(result) {
  if (!result.ok) {
    console.error(result.error);
    return;
  }
  console.log(`\nFinished Short: ${result.finalPath}`);
  console.log(`Title and description: ${result.detailsPath}`);
  if (!result.withAudio) {
    console.log("Note: the Short has no audio track. Add narration and music before posting.");
  }
}

function logEpisodeSummary(summary) {
  console.log("");
  console.log(`Generated this run: ${summary.generated.length}`);
  for (const failure of summary.failed) {
    console.log(`Failed scene ${failure.scene.number} (${failure.scene.name}): ${failure.error}`);
  }
  if (summary.stoppedReason) {
    console.log(`Stopped: ${summary.stoppedReason}`);
  }
  if (summary.missing.length) {
    const numbers = summary.missing.map((scene) => scene.number).join(", ");
    console.log(`Still missing scene(s): ${numbers}. Run the same command again to continue.`);
  }
  if (summary.stitched) {
    logStitchResult(summary.stitched);
  }
}

async function run() {
  await bootstrap();

  yargs(hideBin(process.argv))
    .scriptName("autosocial")
    .command(
      "login",
      "Open browser to log in and persist session",
      () => {},
      async () => {
        await startLoginSession();
      }
    )
    .command(
      "post",
      "Post a specific video or next queue item",
      (builder) =>
        builder
          .option("video", {
            type: "string",
            describe: "Path to video file. If omitted, takes next item from queue.",
          })
          .option("caption", {
            type: "string",
            describe: "Caption text for manual --video posting.",
          }),
      async (argv) => {
        const result = argv.video
          ? await postFromManualInput(path.resolve(argv.video), argv.caption)
          : await postNextFromQueue();
        logResult(result);
      }
    )
    .command(
      "daemon",
      "Start scheduler daemon to post from queue automatically",
      () => {},
      async () => {
        await runScheduledPost();
        startDaemon();
      }
    )
    .command(
      "uniquify",
      "Modify video metadata & pixels to make it unique before uploading",
      (builder) =>
        builder
          .option("video", {
            type: "string",
            describe: "Path to a single video file to uniquify.",
          })
          .option("dir", {
            type: "string",
            describe: "Path to a directory of videos to uniquify. Defaults to queue/default/tiktok/pending.",
          })
          .option("in-place", {
            type: "boolean",
            default: false,
            describe: "Replace the original file instead of creating a new one.",
          })
          .option("overlay", {
            type: "string",
            describe: "Path to an image (PNG/JPG) to use as a flickering watermark overlay.",
          })
          .option("remove-audio", {
            type: "boolean",
            default: false,
            describe: "Remove audio track from output video.",
          })
          .option("no-color-shift", { type: "boolean", default: false, describe: "Skip brightness/contrast/saturation changes." })
          .option("no-hue-shift", { type: "boolean", default: false, describe: "Skip hue rotation." })
          .option("no-noise", { type: "boolean", default: false, describe: "Skip noise overlay." })
          .option("no-pixel-shift", { type: "boolean", default: false, describe: "Skip pixel grid micro-crop." })
          .option("no-speed-shift", { type: "boolean", default: false, describe: "Skip micro speed adjustment." })
          .option("no-audio-pitch", { type: "boolean", default: false, describe: "Skip audio pitch shift." })
          .option("no-volume-shift", { type: "boolean", default: false, describe: "Skip volume adjustment." })
          .check((argv) => {
            if (!argv.video && !argv.dir) return true;
            if (argv.video && argv.dir) throw new Error("Provide either --video or --dir, not both.");
            return true;
          }),
      async (argv) => {
        const hasFfmpeg = await checkFfmpeg();
        if (!hasFfmpeg) {
          console.error("ffmpeg is not installed or not in PATH.");
          console.error("Install it from https://ffmpeg.org/download.html");
          process.exit(1);
        }

        const options = {
          inPlace: argv.inPlace,
          overlayImage: argv.overlay ? path.resolve(argv.overlay) : null,
          removeAudio: argv.removeAudio,
          colorShift: !argv.noColorShift,
          hueShift: !argv.noHueShift,
          noise: !argv.noNoise,
          pixelShift: !argv.noPixelShift,
          speedShift: !argv.noSpeedShift,
          audioPitch: !argv.noAudioPitch,
          volumeShift: !argv.noVolumeShift,
        };

        if (argv.video) {
          const videoPath = path.resolve(argv.video);
          if (options.inPlace) {
            await uniquifyInPlace(videoPath, options);
          } else {
            const result = await uniquifyVideo(videoPath, null, options);
            console.log(`\nUniquified file: ${result.outputPath}`);
          }
        } else {
          const targetDir = argv.dir ? path.resolve(argv.dir) : config.queueDir;
          await uniquifyDirectory(targetDir, options);
        }
      }
    )
    .command(
      "video-info",
      "Show metadata and stream info for a video file",
      (builder) =>
        builder.option("video", {
          type: "string",
          demandOption: true,
          describe: "Path to the video file.",
        }),
      async (argv) => {
        const hasFfmpeg = await checkFfmpeg();
        if (!hasFfmpeg) {
          console.error("ffmpeg/ffprobe is not installed or not in PATH.");
          process.exit(1);
        }

        const info = await getVideoInfo(path.resolve(argv.video));
        console.log(JSON.stringify(info, null, 2));
      }
    )
    .command(
      "flow-login",
      "Open Google Flow in a browser to sign in and save the session",
      () => {},
      async () => {
        await runFlowLogin();
      }
    )
    .command(
      "flow-generate",
      "Generate an episode's scenes in Google Flow, download them, and stitch the Short",
      (builder) =>
        builder
          .option("episode", {
            type: "string",
            demandOption: true,
            describe: "Path to an episode .flow.json file.",
          })
          .option("scenes", {
            type: "string",
            describe: "Only these scenes, e.g. 3 or 1,4 or 2-5. Default: all missing scenes.",
          })
          .option("force", {
            type: "boolean",
            default: false,
            describe: "Regenerate scenes even if their clip is already downloaded.",
          })
          .option("stitch", {
            type: "boolean",
            default: true,
            describe: "Join the clips into one Short once every scene is downloaded (--no-stitch to skip).",
          })
          .option("mute", {
            type: "boolean",
            default: false,
            describe: "Drop Flow's generated audio from the final Short.",
          }),
      async (argv) => {
        await ensureFfmpegForStitch(argv.stitch);
        const summary = await produceEpisode({
          episodeFile: path.resolve(argv.episode),
          scenes: argv.scenes,
          force: argv.force,
          stitch: argv.stitch,
          mute: argv.mute,
        });
        logEpisodeSummary(summary);
        if (summary.failed.length || summary.stoppedReason) {
          process.exitCode = 1;
        }
      }
    )
    .command(
      "stitch",
      "Join an episode's downloaded scene clips into one vertical Short",
      (builder) =>
        builder
          .option("episode", {
            type: "string",
            demandOption: true,
            describe: "Path to an episode .flow.json file.",
          })
          .option("mute", {
            type: "boolean",
            default: false,
            describe: "Drop the clips' audio from the final Short.",
          }),
      async (argv) => {
        await ensureFfmpegForStitch(true);
        const result = await stitchEpisode({
          episodeFile: path.resolve(argv.episode),
          mute: argv.mute,
        });
        logStitchResult(result);
        if (!result.ok) process.exitCode = 1;
      }
    )
    .demandCommand(1, "Provide a command: login, post, daemon, uniquify, video-info, flow-login, flow-generate, stitch")
    .strict()
    .help()
    .parse();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

