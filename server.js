'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── middleware ──────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));

// ── job store (in-memory; fine for single-instance Railway deployment) ──
const jobs = {};   // jobId → { status, log, outputPath, error }

// ── multer: accept script + optional assets ──────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB per file
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/generate
// body (multipart):
//   script     - .txt script file
//   assets[]   - optional image / audio files
//   apiKey     - ElevenLabs / AI33Pro key
//   theme      - "dark" | "light"
//   sentSfx    - optional (defaults to sent.mp3)
//   receivedSfx- optional (defaults to received.mp3)
// ─────────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.fields([
  { name: 'script',    maxCount: 1 },
  { name: 'assets',    maxCount: 30 },
  { name: 'sentSfx',   maxCount: 1 },
  { name: 'receivedSfx', maxCount: 1 },
]), async (req, res) => {
  try {
    const apiKey  = (req.body.apiKey  || '').trim();
    const theme   = (req.body.theme   || 'dark').trim();

    if (!req.files?.script?.[0]) {
      return res.status(400).json({ error: 'Script file is required.' });
    }
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required.' });
    }

    const jobId  = uuidv4();
    const jobDir = path.join(os.tmpdir(), `job_${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    // Move script into job dir
    const scriptSrc  = req.files.script[0].path;
    const scriptDest = path.join(jobDir, 'script.txt');
    fs.renameSync(scriptSrc, scriptDest);

    // Move asset files into job dir (images, sfx, avatar etc.)
    for (const f of (req.files.assets || [])) {
      const dest = path.join(jobDir, f.originalname);
      fs.renameSync(f.path, dest);
    }

    // Handle custom sent / received sfx
    let sentSfxPath     = path.join(jobDir, 'sent.mp3');
    let receivedSfxPath = path.join(jobDir, 'received.mp3');

    if (req.files?.sentSfx?.[0]) {
      fs.renameSync(req.files.sentSfx[0].path, sentSfxPath);
    } else {
      // Write built-in silent placeholder so the code doesn't crash
      _writeSilentMp3Placeholder(sentSfxPath);
    }
    if (req.files?.receivedSfx?.[0]) {
      fs.renameSync(req.files.receivedSfx[0].path, receivedSfxPath);
    } else {
      _writeSilentMp3Placeholder(receivedSfxPath);
    }

    // Register job
    jobs[jobId] = { status: 'queued', log: [], outputPath: null, error: null };

    // Run async (don't await)
    _runJob(jobId, jobDir, scriptDest, apiKey, theme, sentSfxPath, receivedSfxPath).catch(err => {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = err.message;
    });

    return res.json({ jobId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/status/:jobId ────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status:     job.status,
    log:        job.log,
    error:      job.error,
    downloadUrl: job.outputPath ? `/api/download/${req.params.jobId}` : null,
  });
});

// ── GET /api/download/:jobId ─────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'File not ready or not found' });
  }
  res.download(job.outputPath, path.basename(job.outputPath));
});

// ─────────────────────────────────────────────────────────────────────
// INTERNAL: run the texting-video pipeline in a child process
// ─────────────────────────────────────────────────────────────────────
async function _runJob(jobId, jobDir, scriptPath, apiKey, theme, sentSfx, receivedSfx) {
  const { fork } = require('child_process');
  const job = jobs[jobId];
  job.status = 'running';
  job.log.push(`[${_ts()}] Job started. Theme: ${theme}`);

  return new Promise((resolve, reject) => {
    const worker = fork(path.join(__dirname, 'worker.js'), [], {
      env: {
        ...process.env,
        JOB_ID:       jobId,
        SCRIPT_PATH:  scriptPath,
        BASE_DIR:     jobDir,
        API_KEY:      apiKey,
        THEME:        theme,
        SENT_SFX:     sentSfx,
        RECEIVED_SFX: receivedSfx,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    worker.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) { job.log.push(`[${_ts()}] ${line}`); console.log(`[JOB ${jobId}]`, line); }
    });
    worker.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) { job.log.push(`[${_ts()}] ${line}`); }
    });

    worker.on('message', msg => {
      if (msg.type === 'done') {
        job.status     = 'done';
        job.outputPath = msg.outputPath;
        job.log.push(`[${_ts()}] ✅ Done! ${path.basename(msg.outputPath)}`);
        resolve();
      }
      if (msg.type === 'error') {
        job.status = 'error';
        job.error  = msg.error;
        job.log.push(`[${_ts()}] ❌ Error: ${msg.error}`);
        reject(new Error(msg.error));
      }
    });

    worker.on('exit', code => {
      if (job.status === 'running') {
        job.status = 'error';
        job.error  = `Worker exited with code ${code}`;
        reject(new Error(job.error));
      }
    });
  });
}

function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Write a minimal valid silent MP3 (44 bytes) so ffmpeg doesn't crash
function _writeSilentMp3Placeholder(p) {
  if (fs.existsSync(p)) return;
  // 1-second silent WAV header trick: use ffmpeg if available, else skip
  try {
    const { spawnSync } = require('child_process');
    spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '0.5', '-q:a', '9', '-acodec', 'libmp3lame', p,
    ]);
  } catch (_) { /* ffmpeg not installed yet — job will handle it */ }
}

// ── health check ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
