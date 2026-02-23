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

// ── job store ────────────────────────────────────────────────────────
// Each entry: { status, log, outputPath, error, jobDir, createdAt }
const jobs = {};

// ── job TTL constants ─────────────────────────────────────────────────
const JOB_TTL_MS       = 10 * 60 * 1000;  // 10 min: auto-delete after done/error
const JOB_MAX_STORE    = 50;               // hard cap on in-memory jobs
const CLEANUP_INTERVAL =  2 * 60 * 1000;  // sweep every 2 min

// ── periodic cleanup ──────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of Object.entries(jobs)) {
    const age      = now - job.createdAt;
    const finished = job.status === 'done' || job.status === 'error';

    // Delete finished jobs older than TTL
    if (finished && age > JOB_TTL_MS) {
      _deleteJob(jobId);
      continue;
    }

    // Kill jobs stuck in "running" for over 20 min (worker died silently)
    if (job.status === 'running' && age > 20 * 60 * 1000) {
      job.status = 'error';
      job.error  = 'Job timed out after 20 minutes.';
      _cleanJobFiles(job);
    }
  }

  // Hard cap: evict oldest finished jobs if store is too large
  const ids = Object.keys(jobs);
  if (ids.length > JOB_MAX_STORE) {
    ids
      .filter(id => jobs[id].status === 'done' || jobs[id].status === 'error')
      .sort((a, b) => jobs[a].createdAt - jobs[b].createdAt)
      .slice(0, ids.length - JOB_MAX_STORE)
      .forEach(id => _deleteJob(id));
  }
}, CLEANUP_INTERVAL);

function _deleteJob(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  _cleanJobFiles(job);
  delete jobs[jobId];
  console.log(`[CLEANUP] Removed job ${jobId}`);
}

function _cleanJobFiles(job) {
  // Delete job working directory (WAVs, frames, script, assets, tts_cache)
  if (job.jobDir && fs.existsSync(job.jobDir)) {
    try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch (_) {}
  }
  // Delete final output MP4
  if (job.outputPath && fs.existsSync(job.outputPath)) {
    try { fs.unlinkSync(job.outputPath); } catch (_) {}
  }
}

// ── multer ────────────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/generate
// ─────────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.fields([
  { name: 'script',      maxCount: 1  },
  { name: 'assets',      maxCount: 30 },
  { name: 'sentSfx',     maxCount: 1  },
  { name: 'receivedSfx', maxCount: 1  },
]), async (req, res) => {
  try {
    const apiKey      = (req.body.apiKey      || '').trim();
    const theme       = (req.body.theme       || 'dark').trim();
    const ttsProvider = (req.body.ttsProvider || 'ai33pro').trim();

    if (!req.files?.script?.[0])
      return res.status(400).json({ error: 'Script file is required.' });
    if (!apiKey)
      return res.status(400).json({ error: 'API key is required.' });
    if (!['ai33pro', 'elevenlabs'].includes(ttsProvider))
      return res.status(400).json({ error: 'Invalid ttsProvider.' });

    // Reject if already at capacity (prevents OOM from concurrent heavy jobs)
    const activeCount = Object.values(jobs)
      .filter(j => j.status === 'running' || j.status === 'queued').length;
    if (activeCount >= 2) {
      return res.status(429).json({ error: 'Server busy — 2 jobs already running. Try again in a moment.' });
    }

    const jobId  = uuidv4();
    const jobDir = path.join(os.tmpdir(), `job_${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    const scriptDest = path.join(jobDir, 'script.txt');
    fs.renameSync(req.files.script[0].path, scriptDest);

    for (const f of (req.files.assets || [])) {
      fs.renameSync(f.path, path.join(jobDir, f.originalname));
    }

    let sentSfxPath     = path.join(jobDir, 'sent.mp3');
    let receivedSfxPath = path.join(jobDir, 'received.mp3');

    if (req.files?.sentSfx?.[0])     fs.renameSync(req.files.sentSfx[0].path,    sentSfxPath);
    else                              _writeSilentMp3Placeholder(sentSfxPath);
    if (req.files?.receivedSfx?.[0]) fs.renameSync(req.files.receivedSfx[0].path, receivedSfxPath);
    else                              _writeSilentMp3Placeholder(receivedSfxPath);

    jobs[jobId] = {
      status:     'queued',
      log:        [],
      outputPath: null,
      error:      null,
      jobDir,
      createdAt:  Date.now(),
    };

    _runJob(jobId, jobDir, scriptDest, apiKey, theme, ttsProvider, sentSfxPath, receivedSfxPath)
      .catch(err => {
        if (jobs[jobId]) { jobs[jobId].status = 'error'; jobs[jobId].error = err.message; }
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
  if (!job) return res.status(404).json({ error: 'Job not found or already cleaned up.' });
  res.json({
    status:      job.status,
    log:         job.log,
    error:       job.error,
    downloadUrl: job.outputPath ? `/api/download/${req.params.jobId}` : null,
  });
});

// ── GET /api/download/:jobId ──────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'File not ready or already cleaned up. Download before 10 minutes.' });
  }
  res.download(job.outputPath, path.basename(job.outputPath), err => {
    if (!err) {
      // 60-second grace period then delete
      setTimeout(() => _deleteJob(req.params.jobId), 60 * 1000);
    }
  });
});

// ── GET /api/queue ────────────────────────────────────────────────────
app.get('/api/queue', (_req, res) => {
  const active = Object.values(jobs).filter(j => j.status === 'running').length;
  const queued = Object.values(jobs).filter(j => j.status === 'queued').length;
  res.json({ active, queued, total: Object.keys(jobs).length });
});

// ─────────────────────────────────────────────────────────────────────
// INTERNAL: run pipeline in child process
// ─────────────────────────────────────────────────────────────────────
async function _runJob(jobId, jobDir, scriptPath, apiKey, theme, ttsProvider, sentSfx, receivedSfx) {
  const { fork } = require('child_process');
  const job = jobs[jobId];
  job.status = 'running';
  job.log.push(`[${_ts()}] Job started. Theme: ${theme} | TTS: ${ttsProvider}`);

  return new Promise((resolve, reject) => {
    const worker = fork(path.join(__dirname, 'worker.js'), [], {
      env: {
        ...process.env,
        JOB_ID:       jobId,
        SCRIPT_PATH:  scriptPath,
        BASE_DIR:     jobDir,
        API_KEY:      apiKey,
        THEME:        theme,
        TTS_PROVIDER: ttsProvider,
        SENT_SFX:     sentSfx,
        RECEIVED_SFX: receivedSfx,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    worker.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line && jobs[jobId]) { jobs[jobId].log.push(`[${_ts()}] ${line}`); console.log(`[JOB ${jobId}]`, line); }
    });
    worker.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line && jobs[jobId]) jobs[jobId].log.push(`[${_ts()}] ${line}`);
    });

    worker.on('message', msg => {
      if (!jobs[jobId]) return;
      if (msg.type === 'done') {
        jobs[jobId].status     = 'done';
        jobs[jobId].outputPath = msg.outputPath;
        jobs[jobId].log.push(`[${_ts()}] ✅ Done! ${path.basename(msg.outputPath)}`);
        resolve();
      }
      if (msg.type === 'error') {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = msg.error;
        jobs[jobId].log.push(`[${_ts()}] ❌ Error: ${msg.error}`);
        _cleanJobFiles(jobs[jobId]);   // free disk immediately on error
        reject(new Error(msg.error));
      }
    });

    worker.on('exit', code => {
      if (jobs[jobId] && jobs[jobId].status === 'running') {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = `Worker exited with code ${code}`;
        _cleanJobFiles(jobs[jobId]);
        reject(new Error(jobs[jobId].error));
      }
    });
  });
}

function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function _writeSilentMp3Placeholder(p) {
  if (fs.existsSync(p)) return;
  try {
    const { spawnSync } = require('child_process');
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '0.5', '-q:a', '9', '-acodec', 'libmp3lame', p]);
  } catch (_) {}
}

// ── health check ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, jobs: Object.keys(jobs).length }));

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));