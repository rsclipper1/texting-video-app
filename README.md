# TextingAI Video Generator — Railway Deployment

## 📁 Project Structure

```
texting-video-app/
├── server.js           ← Express web server
├── worker.js           ← Child process that runs the video pipeline
├── texting_video.js    ← YOUR original video generation code (copy here)
├── public/
│   └── index.html      ← Beautiful web UI
├── package.json
├── nixpacks.toml       ← Tells Railway to install ffmpeg + chromium
├── Procfile
└── .gitignore
```

## 🚀 Deploy to Railway (Free Tier)

### Step 1 — Prepare Files
1. Copy your `texting_video.js` into this folder
2. Make sure `nixpacks.toml` is present (installs ffmpeg/chromium automatically)

### Step 2 — Patch texting_video.js for web use
Add this near the top of `texting_video.js`, right after the THEME definition:

```js
// ── WEB MODE: respect FORCE_THEME env var ──
if (process.env.FORCE_THEME && THEMES[process.env.FORCE_THEME]) {
  THEME = THEMES[process.env.FORCE_THEME];
}
```

And at the very bottom, **replace** the `main()` call with:

```js
// Only auto-run when invoked directly (not when require()'d by worker)
if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
```

### Step 3 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create texting-video-app --public --push
```

### Step 4 — Deploy on Railway
1. Go to https://railway.app → **New Project → Deploy from GitHub repo**
2. Select your repo
3. Railway auto-detects `nixpacks.toml` → installs ffmpeg + chromium
4. Wait ~3 min for build
5. Click **Settings → Networking → Generate Domain** to get your public URL

### Step 5 — Open your app
Visit the generated URL, upload your script + API key, hit Generate!

---

## 🔧 How It Works

```
Browser → POST /api/generate (multipart: script, assets, apiKey, theme)
       → Returns { jobId }

Browser → GET /api/status/:jobId  (polls every 1.8s)
       → Returns { status, log[], downloadUrl }

Browser → GET /api/download/:jobId
       → Streams the .mp4 file
```

The server forks a `worker.js` child process per job, which calls `runTextingVideo()` from your original code. All file I/O happens in a temp dir under `/tmp`.

---

## ⚠️ Railway Free Tier Notes

- **500 hours/month** free (enough for personal use)
- **512 MB RAM** — videos with many messages may need the $5/mo Hobby plan
- Files are stored in `/tmp` (ephemeral) — download your video before the next deploy
- Puppeteer/Chromium works fine with the `chromium` nix package

---

## 🛠 Local Development

```bash
npm install
node server.js
# Open http://localhost:3000
```

Requires: `ffmpeg` and `ffprobe` in PATH, plus Node 18+.
