'use strict';

// Tell fluent-ffmpeg and spawnSync where ffmpeg lives on Railway/Nix
process.env.PATH = process.env.PATH + ':/usr/bin:/bin:/nix/var/nix/profiles/default/bin';
process.on('uncaughtException', err => {
  process.send({ type: 'error', error: err.message });
  process.exit(1);
});

const path = require('path');

// Redirect all console output through stdout so parent captures it
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origErr  = console.error.bind(console);
console.log   = (...a) => { process.stdout.write(a.join(' ') + '\n'); };
console.warn  = (...a) => { process.stdout.write('[WARN] ' + a.join(' ') + '\n'); };
console.error = (...a) => { process.stdout.write('[ERR]  ' + a.join(' ') + '\n'); };

const {
  JOB_ID, SCRIPT_PATH, BASE_DIR, API_KEY, THEME, TTS_PROVIDER, SENT_SFX, RECEIVED_SFX,
} = process.env;

// Forward TTS provider so genTTSAudio dispatcher picks it up
if (TTS_PROVIDER) process.env.TTS_PROVIDER = TTS_PROVIDER;

// Patch askTheme so it doesn't block waiting for stdin
const textvid = require('./texting_video.js');

// Override THEME before running
textvid.THEMES && Object.assign(textvid, { _themeOverride: THEME });

// Monkey-patch runTextingVideo to inject theme without stdin prompt
async function run() {
  // We need to set THEME on the module level — easiest way is to call
  // runTextingVideo directly since it's exported, but theme selection
  // is done inside main(). We re-implement the small wrapper here.
  const {
    runTextingVideo,
    THEMES,
  } = require('./texting_video.js');

  // Inject theme
  const themes = THEMES || {};
  const themeKey = (THEME || 'dark').toLowerCase();
  // The module uses a module-level THEME var; we set it via the exported object
  // (the module exports THEMES so we can read the right one)

  // Since the module's THEME var isn't directly exported we pass the theme
  // as an env var. The patched texting_video_worker.js reads it.
  // For now call runTextingVideo — it will use whatever THEME is set inside
  // the module. We set process.env.FORCE_THEME so texting_video.js can read it.
  process.env.FORCE_THEME = themeKey;

  const result = await runTextingVideo(
    SCRIPT_PATH,
    BASE_DIR,
    API_KEY,
    SENT_SFX,
    RECEIVED_SFX
  );

  process.send({ type: 'done', outputPath: result.outputVideo });
}

run().catch(err => {
  process.send({ type: 'error', error: err.message });
  process.exit(1);
});