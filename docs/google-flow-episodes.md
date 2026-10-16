# Google Flow Episodes

Turn a scene-by-scene episode file into a finished vertical Short:

1. ContentMachine opens Google Flow in its own browser window, signed in to
   your Google account.
2. It submits each scene's prompt, waits for Veo to finish, and downloads the
   clip as `scene-01.mp4`, `scene-02.mp4`, and so on.
3. When every scene is downloaded, FFmpeg joins them into one 1080x1920 video
   and writes the title and description next to it.

Google Flow has no public API, so this automates the Flow website the same way
the uploaders automate TikTok, Instagram, and YouTube. Automating Flow may not
be allowed by Flow's terms, and the risk sits with your Google account. Flow
also changes its page layout from time to time, which can break the automation
until the selectors are updated.

## Requirements

- Node.js dependencies installed (`npm ci`) and Playwright Chromium.
- FFmpeg and ffprobe on your PATH (for stitching).
- A Google account with Flow access and credits.

## One-Time Setup

1. Sign in to Flow and save the session:

   ```bash
   npm run flow:login
   ```

   Sign in to Google in the window that opens, then close the window. The
   session is stored in `.profile-flow/` (ignored by git).

2. Recommended: set up a Flow project once by hand, then reuse it.
   - Open Flow, create a new project.
   - In the project settings pick the Veo model you want (Lite or Fast uses
     fewer credits), the **9:16 portrait** aspect ratio, and **1 output per
     prompt** so each scene costs one generation instead of two.
   - Copy the project's URL into `.env`:

     ```bash
     FLOW_PROJECT_URL=https://labs.google/fx/tools/flow/project/...
     ```

   Without `FLOW_PROJECT_URL`, a new project is created on each run using
   Flow's default settings, which may be landscape and two outputs per prompt.

## Generate an Episode

```bash
npm run flow:generate -- --episode content/kids-shorts/ep01-pip-rainbow-colors.flow.json
```

Keep the browser window open while it runs. Output goes to
`output/episodes/<episode-id>/`:

- `scene-01.mp4` ... `scene-09.mp4` - the raw clips
- `<episode-id>.mp4` - the finished Short
- `upload-details.txt` - title and description to paste into YouTube

### Running Out of Credits

Free Flow credits cover only a few clips a day. When Flow says you are out of
credits, the run stops and keeps every clip it already downloaded. Run the
same command again later and it continues with the missing scenes.

### Useful Options

| Option | What it does |
| --- | --- |
| `--scenes 3` / `--scenes 2-4,7` | Only generate those scenes. |
| `--force` | Regenerate scenes even if a clip already exists (for redos). |
| `--no-stitch` | Download clips only; skip the final video. |
| `--mute` | Drop Veo's generated audio from the finished Short. |

To redo one bad scene: `npm run flow:generate -- --episode <file> --scenes 4 --force`.

To rebuild the finished Short from existing clips without using credits:

```bash
npm run stitch -- --episode content/kids-shorts/ep01-pip-rainbow-colors.flow.json
```

## Episode File Format

```json
{
  "id": "ep01-pip-rainbow-colors",
  "title": "YouTube title",
  "description": "YouTube description",
  "character": "Full description of the main character",
  "style": "Art style, framing, and audio notes added to every scene",
  "scenes": [
    { "name": "Hook", "prompt": "{character} waves hello. {style}" }
  ]
}
```

`{character}` and `{style}` are replaced in every scene, so the character is
described identically each time. That keeps them looking consistent across
clips. `id` must use lowercase letters, numbers, and dashes.

## Troubleshooting

- **"Not signed in to Google Flow"**: run `npm run flow:login` again.
- **"Could not find the Flow prompt box"**: open Flow yourself, create a
  project, and set `FLOW_PROJECT_URL`.
- **A scene fails**: check the screenshot named in the error
  (`last-flow-error-scene-NN.png`). Content filters sometimes reject a prompt;
  reword that scene in the episode file and rerun with `--scenes N --force`.
- **Generation takes too long**: raise `FLOW_GENERATION_TIMEOUT_MS` (default
  600000, which is 10 minutes).

## Before Posting Kids' Content

The finished Short has Veo's audio, or none with `--mute`. Add narration and
music in an editor before posting. When uploading to YouTube, set the audience
to **"Yes, it's made for kids"**. The built-in YouTube uploader currently marks
every upload as not made for kids, so post kids' episodes manually.
