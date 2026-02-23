'use strict';

/**
 * texting_video.js
 * Node.js port of the Python iMessage video generator.
 *
 * Dependencies (npm install):
 *   canvas sharp puppeteer axios fluent-ffmpeg readline-sync
 *
 * System requirements:
 *   ffmpeg, ffprobe (in PATH)
 *   A TrueType/OpenType font at FONT_PATH (SF-Pro-Display-Regular.otf)
 */

const { createCanvas, loadImage, registerFont, Image } = require('canvas');
const sharp   = require('sharp');
const puppeteer = require('puppeteer');
const axios   = require('axios');
const fs      = require('fs');
const fsp     = require('fs/promises');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execSync, spawnSync, spawn } = require('child_process');
const readline = require('readline');

// Ensure ffmpeg is findable in all environments
const { execSync: _exec } = require('child_process');
try {
  const ffmpegPath = _exec('which ffmpeg').toString().trim();
  console.log('[FFMPEG PATH]', ffmpegPath);
} catch(e) {
  console.warn('[FFMPEG] ffmpeg not found in PATH:', process.env.PATH);
}

// =====================================================================
// RESOLUTION: 1080 x 1920 (9:16 portrait)
// =====================================================================
const W         = 1080;
const H         = 1920;
const CHAT_W    = Math.round(620 * 1.5);   // 930
const BG_COLOR  = '#14FF14';               // (20,255,20) as hex
const TOPBAR_H  = Math.round(150 * 1.5);   // 225
const FONT_PATH = 'SF-Pro-Display-Regular.otf';
const PAGE_SIZE_TEXT       = 9;
const PAGE_SIZE_WITH_IMAGE = 6;
const CORNER_RADIUS        = Math.round(36 * 1.5);   // 54

let IMAGE_BASE_DIR = '.';
let TTS_CACHE_DIR  = 'tts_cache';

const SENT_SFX_DEFAULT     = 'sent.mp3';
const RECEIVED_SFX_DEFAULT = 'received.mp3';

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp)$/i;

const SVG_TAIL_PATH = (
  'M16.8869 20.1846C11.6869 20.9846 6.55352 18.1212 4.88685 16.2879' +
  'C6.60472 12.1914 -4.00107 2.24186 2.99893 2.24148C4.61754 2.24148' +
  ' 6 -1.9986 11.8869 1.1846C11.9081 2.47144 11.8869 6.92582 11.8869' +
  ' 7.6842C11.8869 18.1842 17.8869 19.5813 16.8869 20.1846Z'
);

// =====================================================================
// PLUG AI & RIZZ AI SETTINGS
// =====================================================================
const PLUGAI_URL    = 'https://plugai-template.vercel.app/';
const PLUGAI_SCALE  = 0.60;

const RIZZ_URL          = 'https://rizz-template.vercel.app/';
const RIZZ_SCALE        = 1.15;
const RIZZ_REVEAL_RATIO = 0.65;

// =====================================================================
// THEME DEFINITIONS
// =====================================================================
const THEMES = {
  dark: {
    chat_bg:        [0,   0,   0  ],
    bubble_sent:    [29,  119, 254],
    bubble_rcvd:    [39,  39,  39 ],
    header_bg_hex:  '#1b191c',
    name_fill_hex:  '#e9e9e9',
    name_weight:    '600',
    avatar_bg_rgba: [0,   0,   0,  0  ],
    rcvd_text_color:[255, 255, 255, 255],
    filename_tag:   'dark',
  },
  light: {
    chat_bg:        [254, 254, 254],
    bubble_sent:    [32,  141, 246],
    bubble_rcvd:    [232, 232, 232],
    header_bg_hex:  '#F2F2F7',
    name_fill_hex:  '#111111',
    name_weight:    '400',
    avatar_bg_rgba: [242, 242, 247, 255],
    rcvd_text_color:[0,   0,   0,  255],
    filename_tag:   'light',
  },
};

let THEME = THEMES.dark;
if (process.env.FORCE_THEME && THEMES[process.env.FORCE_THEME]) {
  THEME = THEMES[process.env.FORCE_THEME];
}

// =====================================================================
// UTILITY: RGB array → CSS string
// =====================================================================
function rgb(arr) {
  return `rgb(${arr[0]},${arr[1]},${arr[2]})`;
}
function rgba(arr) {
  const a = arr.length === 4 ? arr[3] / 255 : 1;
  return `rgba(${arr[0]},${arr[1]},${arr[2]},${a})`;
}
function toHex(arr) {
  return '#' + arr.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
}

// =====================================================================
// THEME SELECTOR (interactive CLI)
// =====================================================================
async function askTheme() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   iMessage Video Theme Selector      ║');
    console.log('╠══════════════════════════════════════╣');
    console.log('║  1 - Dark                            ║');
    console.log('║  2 - Light                           ║');
    console.log('╚══════════════════════════════════════╝');
    const ask = () => rl.question('Enter your choice (1 or 2): ', ans => {
      if (ans.trim() === '1') { rl.close(); resolve('dark'); }
      else if (ans.trim() === '2') { rl.close(); resolve('light'); }
      else { console.log('  → Please enter 1 (Dark) or 2 (Light).'); ask(); }
    });
    ask();
  });
}

// =====================================================================
// FEATURE HELPERS: blur markers & TTS override
// =====================================================================
function parseTtsOverride(text) {
  const idx = text.indexOf(' == ');
  if (idx !== -1) {
    return [text.slice(0, idx).trim(), text.slice(idx + 4).trim()];
  }
  return [text, text];
}

function stripBlurMarkers(text) {
  return text.replace(/\{([^}]*)\}/g, '$1');
}

function extractBlurRuns(text) {
  const runs = [];
  let last = 0;
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push([text.slice(last, m.index), false]);
    runs.push([m[1], true]);
    last = re.lastIndex;
  }
  if (last < text.length) runs.push([text.slice(last), false]);
  return runs;
}

// =====================================================================
// VOICE MAP (AI33Pro / ElevenLabs)
// =====================================================================
const AI33PRO_VOICE_MAP = {
  adam:     'pNInz6obpgDQGcFmaJgB', alex:    'yl2ZDV1MzN4HbQJbMihG',
  bill:     'pqHfZKP75CvOlQylNhV4', brian:   'nPczCjzI2devNBz1zQrb',
  callum:   'N2lVS1w4EtoT3dr4eOWO', charlie: 'IKne3meq5aSn9XLyUdCD',
  chris:    'iP95p4xoKVk53GoZ742B', daniel:  'onwK4e9ZLuTAKqWW03F9',
  eric:     'cjVigY5qzO86Huf0OWal', george:  'JBFqnCBsd6RMkjVDRZzb',
  harry:    'SOYHLrjzK2X1ezoPC6cr', krishna: 'm5qndnI7u4OAdXhH0Mr5',
  liam:     'TX3LPaxmHKxFdv7VOQHJ', mark:    'UgBBYS2sOqTuMpoF3BR0',
  niraj:    'zgqefOY5FPQ3bB7OZTVR', roger:   'CwhRBWXzGAHq8TQ4Fs17',
  will:     'bIHbv24MWmeRgasZH58o', antoine: 'ErXwobaYiN019PkySvjV',
  alice:    'Xb7hH8MSUJpSbSDYk0k2', bella:   'hpp4J3VqNfWAUOO0d1Us',
  jessica:  'cgSgspJ2msm6clMCkdW9', laura:   'FGY2WhTYpPnrIDTdsKH5',
  lily:     'pFZP5JQG7iQjIQuC4Bku', matilda: 'XrExE9yKIg1WjnnlVkGX',
  muskan:   'xoV6iGVuOGYHLWjXhVC7', sarah:   'EXAVITQu4vr4xnSDxMaL',
  patrick:  'qwaVDEGNsBllYcZO1ZOJ', cassidy: '56AoDkrOh6qfVPDXZ7Pt',
  river:    'SAz9YHcvj6GT2YYXdXww', arnold:  'VR6AewLTigWG4xSOukaG',
  clyde:    '2EiwWnXFnvU5JabPnv8n', james:   'ZQe5CZNOzWyzPSCn5a3c',
  josh:     'TxGEqnHWrfWFTfGW9XjX', sam:     'yoZ06aMxZJJ28mfd3POQ',
  thomas:   'GBv7mTt0atIp3Br8iCZE', charlotte:'XB0fDUnXU5powFXDhCwa',
  dorothy:  'ThT5KcBeYPX3keUQqHPh', emily:   'LcfcDJNUP1GQjkzn1xUU',
  ella:     'MF3mGyEYCl7XYWbV9V6O', nancy:   'S9E1QZkJ9KpFqk6Gz7pB',
  rachel:   '21m00Tcm4TlvDq8ikWAM', sophie:  'bML4oZ8ZkR6kF5pQWZyN',
  robot:    'D38z5RcWu1voky8WS1ja',
};

function getVoiceId(speaker) {
  return AI33PRO_VOICE_MAP[speaker.toLowerCase()] ||
         Object.values(AI33PRO_VOICE_MAP)[0];
}

// =====================================================================
// TTS CACHE
// =====================================================================
function ttsCachePath(text, speaker) {
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  const spkNorm = speaker.trim().toLowerCase();
  return path.join(TTS_CACHE_DIR, `${spkNorm}_${hash}.mp3`);
}

async function genAi33ProAudio(apiKey, text, outPath, speaker) {
  const cached = ttsCachePath(text, speaker);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    console.log(`[TTS CACHE] HIT  → ${path.basename(cached)}`);
    fs.copyFileSync(cached, outPath);
    return;
  }
  console.log(`[TTS CACHE] MISS → calling AI33Pro for speaker='${speaker}'`);

  const voiceId = getVoiceId(speaker);
  const url = `https://api.ai33.pro/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };
  const payload = {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5, similarity: 0.75, exaggeration: 0.0,
      speed: 1.17, style: 0.5, speaker_boost: true,
    },
    with_transcript: false,
  };

  const resp = await axios.post(url, payload, { headers, timeout: 30000 });
  if (resp.status !== 200) throw new Error(`AI33Pro TTS failed: ${JSON.stringify(resp.data)}`);

  const taskId  = resp.data.task_id;
  const taskUrl = `https://api.ai33.pro/v1/task/${taskId}`;

  let audioUrl;
  while (true) {
    await new Promise(r => setTimeout(r, 600));
    const taskResp = await axios.get(taskUrl, { headers });
    const data = taskResp.data;
    if (data.status === 'done') { audioUrl = data.metadata.audio_url; break; }
    if (data.status === 'error') throw new Error(data.error_message);
  }

  const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
  const buf = Buffer.from(audioResp.data);
  fs.writeFileSync(outPath, buf);
  fs.writeFileSync(cached, buf);
  console.log(`[TTS CACHE] SAVED → ${path.basename(cached)}`);
}

// =====================================================================
// AUDIO HELPERS (ffmpeg/ffprobe via child_process)
// =====================================================================
function getAudioDuration(audioPath) {
  let result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
  ], { encoding: 'utf8' });
  let dur = result.stdout.trim();
  if (!dur || dur === 'N/A') {
    result = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1', audioPath,
    ], { encoding: 'utf8' });
    dur = result.stdout.trim();
  }
  return parseFloat(dur);
}

function convertToWav(inputPath, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', outputPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`WAV conversion failed: ${r.stderr}`);
  return outputPath;
}

function generateSilentWav(durationS, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`,
    '-t', String(durationS), '-c:a', 'pcm_s16le', outputPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Silent WAV failed: ${r.stderr}`);
  return outputPath;
}

function concatWavFiles(wavFiles, outputPath) {
  if (wavFiles.length === 0) return null;
  if (wavFiles.length === 1) { fs.copyFileSync(wavFiles[0], outputPath); return outputPath; }

  const listFile = outputPath.replace('.wav', '_concat.txt');
  const lines = wavFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
  fs.writeFileSync(listFile, lines + '\n');
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath,
  ], { encoding: 'utf8' });
  fs.unlinkSync(listFile);
  if (r.status !== 0) throw new Error(`FFmpeg concat failed: ${r.stderr}`);
  return outputPath;
}

// =====================================================================
// SFX PARSING
// =====================================================================
function parseTextWithSfx(text) {
  const m = text.match(/\s*\[([^\]]+)\]\s*$/);
  if (m) {
    const sfxName = m[1].trim();
    const cleanText = text.replace(/\s*\[([^\]]+)\]\s*$/, '').trim();
    return [cleanText, sfxName];
  }
  return [text.trim(), null];
}

function resolveSfxPath(sfxName, baseDir) {
  if (!sfxName) return null;
  for (const c of [`${path.join(baseDir, sfxName)}.mp3`, path.join(baseDir, sfxName)]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// =====================================================================
// PARSING: script file → threads
// =====================================================================
function parseFileSettingsAndThreads(filename) {
  const lines = fs.readFileSync(filename, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let unreadCount    = '999999+';
  let uiCornerRadius = 50;
  const threads      = [];
  let currentContact = null;
  let currentMsgs    = [];
  let contactAvatar  = null;

  const patThread   = /^iMessage[:\s]+([^:]+)(?:\s*:\s*(.+))?$/i;
  const patUm       = /^UM[:\s]+(\d+)$/i;
  const patCr       = /^CR[:\s]+(\d+)$/i;
  const patPlugsay  = /^plugsay\s*>\s*([^:]+)\s*:\s*(.+)$/i;
  const patPlug     = /^plug\s*>\s*([^:]+)\s*:\s*(.+)$/i;
  const patRizzsay  = /^rizzsay\s*>\s*([^:]+)\s*:\s*(.+)$/i;
  const patRizz     = /^rizz\s*>\s*([^:]+)\s*:\s*(.+)$/i;
  const patBreak    = /^<break\s*:\s*(\d+(?:\.\d+)?)\s*s\s*:?>$/i;

  // First pass: filter UM / CR
  const filteredLines = [];
  for (const line of lines) {
    const mUm = patUm.exec(line);
    const mCr = patCr.exec(line);
    if (mUm) { unreadCount = mUm[1]; }
    else if (mCr) { uiCornerRadius = Math.round(parseInt(mCr[1]) * 1.5); }
    else { filteredLines.push(line); }
  }

  let pendingPlugsay = null;
  let pendingRizzsay = null;

  for (const line of filteredLines) {
    if (/^rizz_say:/i.test(line) || /^rizz:/i.test(line)) continue;

    // <break:Ns>
    const mBr = patBreak.exec(line);
    if (mBr) {
      const durationS = parseFloat(mBr[1]);
      if (currentContact !== null) {
        currentMsgs.push({
          sender: '__break__', speaker: '__break__',
          text: '', tts_text: '', sfx: null,
          audio_only: false, is_plug: false,
          is_break: true, duration_s: durationS,
        });
        console.log(`[PARSER] Break detected: ${durationS}s`);
      }
      continue;
    }

    // plugsay
    const mPs = patPlugsay.exec(line);
    if (mPs) {
      const rawSpeaker = mPs[1].trim();
      const [cleanText, psSfx] = parseTextWithSfx(mPs[2].trim());
      const [psBubble, psTts] = parseTtsOverride(cleanText);
      pendingPlugsay = {
        speaker: rawSpeaker, text: psBubble,
        tts_text: stripBlurMarkers(psTts), sfx: psSfx,
        plugsay_silent: rawSpeaker.toLowerCase() === 'none',
      };
      continue;
    }

    // plug
    const mP = patPlug.exec(line);
    if (mP) {
      const plugSpeaker = mP[1].trim();
      const [plugBubble, plugTts] = parseTtsOverride(mP[2].trim());
      if (currentContact !== null) {
        currentMsgs.push({
          sender: 'plug', speaker: plugSpeaker,
          text: plugBubble, tts_text: stripBlurMarkers(plugTts),
          sfx: null, audio_only: false, is_plug: true,
          plug_silent: plugSpeaker.toLowerCase() === 'none',
          plugsay_speaker:  pendingPlugsay ? pendingPlugsay.speaker   : plugSpeaker,
          plugsay_text:     pendingPlugsay ? pendingPlugsay.text       : '',
          plugsay_tts_text: pendingPlugsay ? pendingPlugsay.tts_text   : '',
          plugsay_sfx:      pendingPlugsay ? pendingPlugsay.sfx        : null,
          plugsay_silent:   pendingPlugsay ? pendingPlugsay.plugsay_silent : false,
        });
      }
      pendingPlugsay = null;
      continue;
    }

    // rizzsay
    const mRs = patRizzsay.exec(line);
    if (mRs) {
      const rawSpeaker = mRs[1].trim();
      const [cleanText, rsSfx] = parseTextWithSfx(mRs[2].trim());
      const [rsBubble, rsTts] = parseTtsOverride(cleanText);
      pendingRizzsay = {
        speaker: rawSpeaker, text: rsBubble,
        tts_text: stripBlurMarkers(rsTts), sfx: rsSfx,
        rizzsay_silent: rawSpeaker.toLowerCase() === 'none',
      };
      continue;
    }

    // rizz
    const mR = patRizz.exec(line);
    if (mR) {
      const rizzSpeaker = mR[1].trim();
      const [rizzBubble, rizzTts] = parseTtsOverride(mR[2].trim());
      if (currentContact !== null) {
        currentMsgs.push({
          sender: 'rizz', speaker: rizzSpeaker,
          text: rizzBubble, tts_text: stripBlurMarkers(rizzTts),
          sfx: null, audio_only: false, is_plug: false, is_rizz: true,
          rizz_silent: rizzSpeaker.toLowerCase() === 'none',
          rizzsay_speaker:  pendingRizzsay ? pendingRizzsay.speaker       : rizzSpeaker,
          rizzsay_text:     pendingRizzsay ? pendingRizzsay.text          : '',
          rizzsay_tts_text: pendingRizzsay ? pendingRizzsay.tts_text      : '',
          rizzsay_sfx:      pendingRizzsay ? pendingRizzsay.sfx           : null,
          rizzsay_silent:   pendingRizzsay ? pendingRizzsay.rizzsay_silent : false,
        });
      }
      pendingRizzsay = null;
      continue;
    }

    // iMessage thread header
    const mThread = patThread.exec(line);
    if (mThread) {
      if (currentContact && currentMsgs.length) {
        threads.push({ contact: currentContact, messages: currentMsgs, avatar: contactAvatar });
      }
      currentContact = mThread[1].trim();
      contactAvatar  = mThread[2] ? mThread[2].trim() : null;
      currentMsgs    = [];
      pendingPlugsay = null;
      pendingRizzsay = null;
      continue;
    }

    // Regular message lines
    if (line.includes('>') && line.includes(':')) {
      const gtIdx   = line.indexOf('>');
      const colIdx  = line.indexOf(':', gtIdx);
      const speakerSide = line.slice(0, gtIdx);
      const senderSide  = line.slice(gtIdx + 1, colIdx);
      const textRaw     = line.slice(colIdx + 1);
      const senderStripped = senderSide.trim();
      const isAudioOnly    = senderStripped.toLowerCase() === 'audio';
      const [cleanText, sfxName] = parseTextWithSfx(textRaw);
      const [bubble, ttsRaw]     = parseTtsOverride(cleanText);
      currentMsgs.push({
        sender: senderStripped, speaker: speakerSide.trim(),
        text: bubble, tts_text: stripBlurMarkers(ttsRaw),
        sfx: sfxName, audio_only: isAudioOnly, is_plug: false,
      });
    } else if (line.includes(':')) {
      const colIdx = line.indexOf(':');
      const sender  = line.slice(0, colIdx).trim();
      const textRaw = line.slice(colIdx + 1);
      const [cleanText, sfxName] = parseTextWithSfx(textRaw);
      const [bubble, ttsRaw]     = parseTtsOverride(cleanText);
      currentMsgs.push({
        sender, speaker: sender,
        text: bubble, tts_text: stripBlurMarkers(ttsRaw),
        sfx: sfxName, audio_only: false, is_plug: false,
      });
    }
  }

  if (currentContact && currentMsgs.length) {
    threads.push({ contact: currentContact, messages: currentMsgs, avatar: contactAvatar });
  }

  return { unreadCount, uiCornerRadius, threads };
}

// =====================================================================
// FONT LOADING
// =====================================================================
let fontRegistered = false;
let FONT_FAMILY    = 'Arial';

function ensureFont() {
  if (fontRegistered) return;
  fontRegistered = true;
  if (!fs.existsSync(FONT_PATH)) {
    console.warn('[FONT]', FONT_PATH, 'not found — using Arial');
    return;
  }
  try {
    registerFont(FONT_PATH, { family: 'SFPro' });
    FONT_FAMILY = 'SFPro';
    console.log('[FONT] Loaded SFPro from', FONT_PATH);
  } catch (e) {
    console.warn('[FONT] registerFont failed:', e.message, '— using Arial');
  }
}

function fontStr(size, weight = 'normal') {
  const w = (weight === '400' || weight === 'normal') ? 'normal'
          : (weight === '600' || weight === '700' || weight === 'bold') ? 'bold'
          : weight;
  return `${w} ${Math.round(size)}px ${FONT_FAMILY}`;
}

// =====================================================================
// TEXT WRAPPING
// =====================================================================
function getTextWidth(ctx, text) {
  return ctx.measureText(text).width;
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    if (getTextWidth(ctx, test) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = w;
      while (getTextWidth(ctx, current) > maxWidth && current.length > 1) {
        for (let i = 1; i < current.length; i++) {
          if (getTextWidth(ctx, current.slice(0, i)) > maxWidth) {
            lines.push(current.slice(0, i - 1));
            current = current.slice(i - 1);
            break;
          }
        }
      }
    }
  }
  lines.push(current);
  return lines.join('\n');
}

// =====================================================================
// ROUNDED RECTANGLE HELPER
// =====================================================================
function roundedRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}

// =====================================================================
// SVG PATH → POLYGON POINTS
// =====================================================================
function parseSvgPathToPoints(d, scaleX = 1, scaleY = 1, ox = 0, oy = 0) {
  const pts = [];
  const cmds = [];
  const re = /([MmCcQqLlZz])\s*([\d\s.,+-]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd  = m[1];
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    cmds.push({ cmd, args });
  }

  let cx = 0, cy = 0;
  function sample(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
  }
  function sampleQ(t, p0, p1, p2) {
    const u = 1 - t;
    return u*u*p0 + 2*u*t*p1 + t*t*p2;
  }

  for (const { cmd, args } of cmds) {
    if (cmd === 'M') { cx = args[0]; cy = args[1]; pts.push([cx, cy]); }
    else if (cmd === 'm') { cx += args[0]; cy += args[1]; pts.push([cx, cy]); }
    else if (cmd === 'L') { cx = args[0]; cy = args[1]; pts.push([cx, cy]); }
    else if (cmd === 'l') { cx += args[0]; cy += args[1]; pts.push([cx, cy]); }
    else if (cmd === 'C') {
      const [x1,y1, x2,y2, ex,ey] = args;
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        pts.push([sample(t, cx, x1, x2, ex), sample(t, cy, y1, y2, ey)]);
      }
      cx = ex; cy = ey;
    }
    else if (cmd === 'c') {
      const [dx1,dy1, dx2,dy2, dex,dey] = args;
      const x1=cx+dx1, y1=cy+dy1, x2=cx+dx2, y2=cy+dy2, ex=cx+dex, ey=cy+dey;
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        pts.push([sample(t, cx, x1, x2, ex), sample(t, cy, y1, y2, ey)]);
      }
      cx = ex; cy = ey;
    }
    else if (cmd === 'Q') {
      const [x1,y1, ex,ey] = args;
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        pts.push([sampleQ(t, cx, x1, ex), sampleQ(t, cy, y1, ey)]);
      }
      cx = ex; cy = ey;
    }
  }
  return pts.map(([x, y]) => [x * scaleX + ox, y * scaleY + oy]);
}

function drawSvgTail(ctx, svgPath, pos, scaleX, scaleY, color) {
  const pts = parseSvgPathToPoints(svgPath, scaleX, scaleY, pos[0], pos[1]);
  if (pts.length === 0) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function drawSvgTailFlipped(ctx, svgPath, pos, scaleX, scaleY, color) {
  const pts = parseSvgPathToPoints(svgPath, scaleX, scaleY, 0, 0);
  ctx.fillStyle = color;
  ctx.beginPath();
  const mapped = pts.map(([x, y]) => [-x + pos[0], y * 1 + pos[1]]);
  ctx.moveTo(mapped[0][0], mapped[0][1]);
  for (let i = 1; i < mapped.length; i++) ctx.lineTo(mapped[i][0], mapped[i][1]);
  ctx.closePath();
  ctx.fill();
}

// =====================================================================
// GAUSSIAN BLUR
// =====================================================================
function gaussianBlurRegion(ctx, x0, y0, x1, y1, radius) {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const imageData = ctx.getImageData(x0, y0, w, h);
  const passes = 3;
  for (let p = 0; p < passes; p++) {
    boxBlurH(imageData.data, w, h, radius);
    boxBlurV(imageData.data, w, h, radius);
  }
  ctx.putImageData(imageData, x0, y0);
}

function boxBlurH(data, w, h, r) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rr = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let kx = -r; kx <= r; kx++) {
        const nx = Math.min(w - 1, Math.max(0, x + kx));
        const i = (y * w + nx) * 4;
        rr += data[i]; g += data[i+1]; b += data[i+2]; a += data[i+3];
        cnt++;
      }
      const i = (y * w + x) * 4;
      data[i] = rr/cnt; data[i+1] = g/cnt; data[i+2] = b/cnt; data[i+3] = a/cnt;
    }
  }
}

function boxBlurV(data, w, h, r) {
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let rr = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let ky = -r; ky <= r; ky++) {
        const ny = Math.min(h - 1, Math.max(0, y + ky));
        const i = (ny * w + x) * 4;
        rr += data[i]; g += data[i+1]; b += data[i+2]; a += data[i+3];
        cnt++;
      }
      const i = (y * w + x) * 4;
      data[i] = rr/cnt; data[i+1] = g/cnt; data[i+2] = b/cnt; data[i+3] = a/cnt;
    }
  }
}

// =====================================================================
// BUBBLE IMAGE
// =====================================================================
function bubbleCanvas(text, sender, width = 630, fontSize = Math.round(28 * 1.5), showTail = true) {
  ensureFont();

  const FONT_SIZE = Math.max(fontSize, 46);
  const padX   = 20;
  const padTop = 20;
  const padBot = 20;
  const maxTW  = width - padX * 2 - Math.round(20 * 1.5);

  const displayNoBlur = stripBlurMarkers(text);

  const measureC   = createCanvas(10, 10);
  const measureCtx = measureC.getContext('2d');
  measureCtx.font  = fontStr(FONT_SIZE);

  const wrapped = wrapText(measureCtx, displayNoBlur, maxTW);
  const lines   = wrapped.split('\n');

  const lineSpacing = 2;
  const lineHeight  = Math.round(FONT_SIZE * 1.22 + lineSpacing);
  const textH       = lines.length * lineHeight;
  const textW       = Math.max(1, ...lines.map(l => measureCtx.measureText(l).width));

  const minBubbleW = Math.round(FONT_SIZE * 2.5);
  const bubbleW    = Math.max(minBubbleW, Math.round(textW + padX * 2 + 4));
  const bubbleH    = Math.round(textH + padTop + padBot + 2);

  const tailRoom = Math.round(20 * 1.5);
  const imgW     = bubbleW + tailRoom + Math.round(5 * 1.5);
  const imgH     = bubbleH + Math.round(8 * 1.5);

  const numLines = lines.length;
  let br = numLines === 1 ? Math.round(23 * 1.5)
         : numLines === 2 ? Math.round(21 * 1.5)
                          : Math.round(19 * 1.5);
  br = Math.min(br, Math.floor(bubbleH / 2) - 2, Math.floor(bubbleW / 2) - 2);

  const SAFE = Math.round(5 * 1.5);

  const colorArr = sender === 'me' ? THEME.bubble_sent : THEME.bubble_rcvd;
  const color    = rgb(colorArr);
  const chatBg   = rgb(THEME.chat_bg);

  const canvas = createCanvas(imgW, imgH);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = chatBg;
  ctx.fillRect(0, 0, imgW, imgH);

  let ox, oy;
  if (sender === 'me') {
    ox = imgW - bubbleW - SAFE;
    oy = 0;
  } else {
    ox = SAFE;
    oy = 0;
  }

  ctx.fillStyle = color;
  roundedRect(ctx, ox, oy, bubbleW, bubbleH, br);
  ctx.fill();

  if (showTail) {
    const tailSX = 2.97;
    const tailSY = 2.025;
    const tailY  = oy + bubbleH - 36;
    if (sender === 'me') {
      drawSvgTail(ctx, SVG_TAIL_PATH, [ox + bubbleW - 37, tailY], tailSX, tailSY, color);
    } else {
      drawSvgTailFlipped(ctx, SVG_TAIL_PATH, [ox + 37, tailY], tailSX, tailSY, color);
    }
  }

  ctx.font         = fontStr(FONT_SIZE);
  ctx.textBaseline = 'top';

  const textColor = sender === 'me'
    ? 'rgb(255,255,255)'
    : `rgb(${THEME.rcvd_text_color[0]},${THEME.rcvd_text_color[1]},${THEME.rcvd_text_color[2]})`;

  const totalTextH = lines.length * lineHeight;
  const tyStart    = oy + Math.round((bubbleH - totalTextH) / 2);
  const blockLeft  = ox + Math.round((bubbleW - textW) / 2);
  let ty = tyStart;
  for (const line of lines) {
    ctx.fillStyle = textColor;
    ctx.fillText(line, blockLeft, ty);
    ty += lineHeight;
  }

  const hasBlur = /{[^}]+}/.test(text);
  if (hasBlur) {
    const wrappedBlur = wrapTextPreservingBlur(text, ctx, maxTW);
    const blurLines   = wrappedBlur.split('\n');
    const totalBH     = blurLines.length * lineHeight;
    let bty = oy + Math.round((bubbleH - totalBH) / 2);

    for (const bline of blurLines) {
      const runs  = extractBlurRuns(bline);
      let btx = blockLeft;

      for (const [seg, isBlurred] of runs) {
        const segW = measureCtx.measureText(stripBlurMarkers(seg)).width;
        if (isBlurred && seg.trim()) {
          const p   = 4;
          const bx0 = Math.max(0,             Math.floor(btx) - p);
          const by0 = Math.max(0,             Math.floor(bty) - p);
          const bx1 = Math.min(canvas.width,  Math.ceil(btx + segW) + p);
          const by1 = Math.min(canvas.height, Math.ceil(bty + lineHeight) + p);
          gaussianBlurRegion(ctx, bx0, by0, bx1, by1, 8);
          ctx.fillStyle = `rgba(${colorArr[0]},${colorArr[1]},${colorArr[2]},0.35)`;
          ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
        }
        btx += segW;
      }
      bty += lineHeight;
    }
  }

  return canvas;
}

function wrapTextPreservingBlur(text, ctx, maxWidth) {
  const parts = text.split(/(\s+)/);
  const lines = [];
  let current = '';
  let currentDisplay = '';

  for (const part of parts) {
    if (!part) continue;
    const partDisplay = stripBlurMarkers(part);
    if (!current) {
      current = part; currentDisplay = partDisplay;
    } else {
      const testDisplay = currentDisplay + partDisplay;
      if (ctx.measureText(testDisplay).width <= maxWidth) {
        current += part; currentDisplay = testDisplay;
      } else if (partDisplay.trim()) {
        lines.push(current.trimEnd());
        current = part.trimStart(); currentDisplay = partDisplay.trimStart();
      }
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.join('\n');
}

// =====================================================================
// IMAGE MESSAGE CLIP
// =====================================================================
async function imageMessageClip(fname, sender, maxWidth = Math.round(200 * 1.5)) {
  let fpath = path.isAbsolute(fname) ? fname : path.join(IMAGE_BASE_DIR, fname);
  if (!fs.existsSync(fpath)) {
    return bubbleCanvas(`[missing ${fname}]`, sender);
  }

  const srcBuf  = fs.readFileSync(fpath);
  const meta    = await sharp(srcBuf).metadata();
  let { width: w, height: h } = meta;
  let resized = srcBuf;

  if (w > maxWidth) {
    const scale = maxWidth / w;
    resized = await sharp(srcBuf).resize(Math.round(w * scale), Math.round(h * scale)).toBuffer();
    w = Math.round(w * scale); h = Math.round(h * scale);
  }

  const pad    = Math.round(12 * 1.5);
  const bgW    = w + pad * 2;
  const bgH    = h + pad * 2;
  const radius = Math.round(24 * 1.5);

  const imgRgba = await sharp(resized).ensureAlpha().toBuffer();
  const imgNode = await loadImage(imgRgba);

  const canvas = createCanvas(bgW, bgH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = rgb(THEME.chat_bg);
  ctx.fillRect(0, 0, bgW, bgH);

  roundedRect(ctx, pad, pad, w, h, Math.round(16 * 1.5));
  ctx.clip();
  ctx.drawImage(imgNode, pad, pad, w, h);
  ctx.restore();

  return canvas;
}

// =====================================================================
// MAKE BUBBLE CLIPS
// =====================================================================
async function makeBubbleClips(msgs) {
  const clips   = [], widths = [], heights = [], senders = [], isImgFlags = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.audio_only || msg.is_plug || msg.is_rizz || msg.is_break) {
      clips.push(null); widths.push(0); heights.push(0);
      senders.push(msg.sender); isImgFlags.push(false);
      continue;
    }

    const sender = msg.sender;
    const textNoBlur = stripBlurMarkers(msg.text);
    const [isImg, fname] = isImageMessage(textNoBlur);

    let isLast = true;
    for (let j = i + 1; j < msgs.length; j++) {
      const next = msgs[j];
      if (next.is_plug || next.audio_only || next.is_break) continue;
      if (next.sender === sender) isLast = false;
      break;
    }

    let clip, w, h;
    if (isImg) {
      clip = await imageMessageClip(fname, sender);
      w = clip.width; h = clip.height;
      isImgFlags.push(true);
    } else {
      clip = bubbleCanvas(msg.text, sender, 630, Math.round(28 * 1.5), isLast);
      w = clip.width; h = clip.height;
      isImgFlags.push(false);
    }

    clips.push(clip); widths.push(w); heights.push(h); senders.push(sender);
  }
  return { clips, widths, heights, senders, isImgFlags };
}

function isImageMessage(text) {
  const t = text.trim();
  const fname = t.split(/\s+/).pop();
  return [IMAGE_EXT_RE.test(fname), fname];
}

// =====================================================================
// HEADER
// =====================================================================
async function createContactHeader(name, unreadCount = null, avatarFile = null) {
  ensureFont();
  const canvas = createCanvas(CHAT_W, TOPBAR_H);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = THEME.header_bg_hex;
  ctx.fillRect(0, 0, CHAT_W, TOPBAR_H);

  const cx       = CHAT_W / 2;
  const AVATAR_R = Math.round(36 * 1.5);
  const AVATAR_Y = Math.round(70 * 1.5);
  const NAME_Y   = Math.round(135 * 1.5);

  ctx.strokeStyle = '#007AFF';
  ctx.lineWidth   = 2.9 * 1.8;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  const cx0 = Math.round(32 * 1.5), cy0 = Math.round(63 * 1.5);
  ctx.beginPath();
  ctx.moveTo(cx0 + 13.5 * 1.8, cy0);
  ctx.lineTo(cx0, cy0 + 13.5 * 1.8);
  ctx.lineTo(cx0 + 13.5 * 1.8, cy0 + 27 * 1.8);
  ctx.stroke();

  const vx = CHAT_W - Math.round(85 * 1.5);
  const vy = Math.round(50 * 1.5);
  ctx.strokeStyle = '#007AFF';
  ctx.lineWidth   = Math.round(2.6 * 1.5);
  ctx.beginPath();
  ctx.roundRect(vx, vy + Math.round(4.5 * 1.5), Math.round(39 * 1.5), Math.round(30 * 1.5), Math.round(7.5 * 1.5));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(vx + Math.round(39 * 1.5), vy + Math.round(15 * 1.5));
  ctx.lineTo(vx + Math.round(52.5 * 1.5), vy + Math.round(9.75 * 1.5));
  ctx.lineTo(vx + Math.round(52.5 * 1.5), vy + Math.round(28.5 * 1.5));
  ctx.lineTo(vx + Math.round(39 * 1.5), vy + Math.round(22.5 * 1.5));
  ctx.closePath();
  ctx.stroke();

  if (unreadCount && unreadCount !== '') {
    const display  = String(unreadCount);
    const pillW    = Math.round(26 * 1.5) + display.length * Math.round(10 * 1.5);
    const pillH    = Math.round(30 * 1.5);
    const pillX    = Math.round(55 * 1.5);
    const pillY    = Math.round(64 * 1.5);
    const pillR    = Math.round(15 * 1.5);
    ctx.fillStyle  = '#007AFF';
    roundedRect(ctx, pillX, pillY, pillW, pillH, pillR);
    ctx.fill();
    ctx.fillStyle   = '#fff';
    ctx.font        = fontStr(Math.round(22 * 1.5), "600");
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(display, pillX + pillW / 2, pillY + pillH / 2);
  }

  if (avatarFile) {
    const aPath = path.isAbsolute(avatarFile) ? avatarFile : path.join(IMAGE_BASE_DIR, avatarFile);
    if (fs.existsSync(aPath)) {
      const avatarSize = Math.round(72 * 1.5);
      const avatarImg  = await loadImage(aPath);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, AVATAR_Y, avatarSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatarImg, cx - avatarSize / 2, AVATAR_Y - avatarSize / 2, avatarSize, avatarSize);
      ctx.restore();
    }
  } else {
    const grad = ctx.createLinearGradient(cx, AVATAR_Y - AVATAR_R, cx, AVATAR_Y + AVATAR_R);
    grad.addColorStop(0, '#A5ABB9');
    grad.addColorStop(1, '#858994');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.fill();

    const initial = (name || '?')[0].toUpperCase();
    ctx.fillStyle    = '#fff';
    ctx.font         = fontStr(Math.round(32 * 1.5), '600');
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, AVATAR_Y);
  }

  ctx.fillStyle    = THEME.name_fill_hex;
  ctx.font         = fontStr(Math.round(24 * 1.5), THEME.name_weight);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';
  const nameX = cx - Math.round(4 * 1.5);
  ctx.fillText(name, nameX, NAME_Y);

  ctx.font = fontStr(Math.round(24 * 1.5), THEME.name_weight);
  const nameW = ctx.measureText(name).width;
  const chX = nameX + nameW / 2 + Math.round(18 * 1.5);
  const chY = NAME_Y - Math.round(18 * 1.5);
  ctx.strokeStyle = '#bbbbbb';
  ctx.lineWidth   = Math.round(2.6 * 1.5);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(chX, chY + Math.round(3 * 1.5));
  ctx.lineTo(chX + Math.round(7 * 1.5), chY + Math.round(10 * 1.5));
  ctx.lineTo(chX, chY + Math.round(17 * 1.5));
  ctx.stroke();

  return canvas;
}

// =====================================================================
// SCENE IMAGE
// =====================================================================
async function createSceneImage(bubbleCanvases, widths, heights, senders, posterCanvas, showPoster, uiRound = 0) {
  const pad          = Math.round(38 * 1.5);
  const maxBW        = CHAT_W - pad * 2;
  const baseGapSame  = -10;
  const baseGapDiff  = 0;

  const visIdx = bubbleCanvases
    .map((c, i) => c !== null ? i : -1)
    .filter(i => i !== -1);

  const gaps = [];
  for (let vi = 0; vi < visIdx.length - 1; vi++) {
    gaps.push(senders[visIdx[vi]] === senders[visIdx[vi + 1]] ? baseGapSame : baseGapDiff);
  }

  const visH = visIdx.map(i => {
    const s = widths[i] > maxBW ? maxBW / widths[i] : 1;
    return Math.round(heights[i] * s);
  });
  const bubblesH = visH.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);

  const chatH = showPoster
    ? TOPBAR_H + Math.round(12 * 1.5) + bubblesH - Math.round(3 * 1.5)
    : bubblesH + Math.round(15 * 1.5);

  const canvas = createCanvas(CHAT_W, Math.max(chatH, showPoster ? TOPBAR_H : 0));
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = rgb(THEME.chat_bg);
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (showPoster && posterCanvas) {
    ctx.drawImage(posterCanvas, 0, 0);
  }

  let y = showPoster ? TOPBAR_H + Math.round(13 * 1.5) : Math.round(14 * 1.5);

  for (let vi = 0; vi < visIdx.length; vi++) {
    const orig   = visIdx[vi];
    const bubble = bubbleCanvases[orig];
    const scale  = widths[orig] > maxBW ? maxBW / widths[orig] : 1;
    const drawW  = Math.round(widths[orig] * scale);
    const drawH  = Math.round(heights[orig] * scale);
    const isMe   = senders[orig] === 'me';
    let bx = isMe ? CHAT_W - drawW - pad : pad;
    bx = Math.min(CHAT_W - drawW - Math.round(5 * 1.5), Math.max(Math.round(5 * 1.5), bx));

    ctx.drawImage(bubble, bx, Math.round(y), drawW, drawH);
    y += drawH + (vi < gaps.length ? gaps[vi] : 0);
  }

  if (uiRound > 0) {
    const masked = createCanvas(canvas.width, canvas.height);
    const mCtx   = masked.getContext('2d');
    roundedRect(mCtx, 0, 0, canvas.width, canvas.height, uiRound);
    mCtx.clip();
    mCtx.drawImage(canvas, 0, 0);
    const frame = createCanvas(W, H);
    const fCtx  = frame.getContext('2d');
    fCtx.fillStyle = BG_COLOR;
    fCtx.fillRect(0, 0, W, H);
    const chatX = (W - CHAT_W) / 2;
    const chatY = Math.round(170 * 1.5);
    fCtx.drawImage(masked, chatX, chatY);
    return frame;
  }

  const frame = createCanvas(W, H);
  const fCtx  = frame.getContext('2d');
  fCtx.fillStyle = BG_COLOR;
  fCtx.fillRect(0, 0, W, H);
  const chatX = (W - CHAT_W) / 2;
  const chatY = Math.round(170 * 1.5);
  fCtx.drawImage(canvas, chatX, chatY);
  return frame;
}

// =====================================================================
// CONTEXT IMAGE FOR PLUG / RIZZ
// =====================================================================
async function renderContextForPlug(msgsSoFar) {
  const visible = msgsSoFar.filter(m =>
    !m.is_plug && !m.is_rizz && !m.audio_only && !m.is_break
  );
  const last3 = visible.slice(-3);
  if (!last3.length) return null;

  const miniClips = [], miniWs = [], miniHs = [], miniSnd = [];

  for (let li = 0; li < last3.length; li++) {
    const msg    = last3[li];
    const sender = msg.sender;
    const [isImg, fname] = isImageMessage(stripBlurMarkers(msg.text));
    const showTail = li + 1 >= last3.length || last3[li + 1].sender !== sender;

    let clip, w, h;
    if (isImg) {
      clip = await imageMessageClip(fname, sender);
    } else {
      clip = bubbleCanvas(msg.text, sender, 630, Math.round(28 * 1.5), showTail);
    }
    w = clip.width; h = clip.height;
    miniClips.push(clip); miniWs.push(w); miniHs.push(h); miniSnd.push(sender);
  }

  const pad = Math.round(38 * 1.5);
  const gaps = [];
  for (let k = 0; k < miniSnd.length - 1; k++) {
    gaps.push(miniSnd[k] === miniSnd[k + 1] ? -10 : 0);
  }

  const topPad    = Math.round(14 * 1.5);
  const bottomPad = Math.round(14 * 1.5);
  const totalH    = topPad + miniHs.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0) + bottomPad;

  const canvas = createCanvas(CHAT_W, Math.round(totalH));
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = rgb(THEME.chat_bg);
  ctx.fillRect(0, 0, CHAT_W, Math.round(totalH));

  let y = topPad;
  const maxW = CHAT_W - pad * 2;

  for (let k = 0; k < miniClips.length; k++) {
    const scale = miniWs[k] > maxW ? maxW / miniWs[k] : 1;
    const drawW = Math.round(miniWs[k] * scale);
    const drawH = Math.round(miniHs[k] * scale);
    const isMe  = miniSnd[k] === 'me';
    let bx = isMe ? CHAT_W - drawW - pad : pad;
    bx = Math.min(CHAT_W - drawW - Math.round(5 * 1.5), Math.max(Math.round(5 * 1.5), bx));
    ctx.drawImage(miniClips[k], bx, Math.round(y), drawW, drawH);
    y += drawH + (k < gaps.length ? gaps[k] : 0);
  }

  return canvas;
}

// =====================================================================
// PUPPETEER: PLUG AI
// =====================================================================
async function runPlugSelenium(replyText, contextImgPath, dlFolder) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    defaultViewport: { width: 1920, height: 1080 },
  });
  let downloadedPath = null;

  try {
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(dlFolder),
    });

    console.log(`[PLUG PUPPETEER] Opening ${PLUGAI_URL}`);
    await page.goto(PLUGAI_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(path.resolve(contextImgPath));
        await new Promise(r => setTimeout(r, 2500));
      }
    } catch (e) { console.warn('[PLUG PUPPETEER] File upload warning:', e.message); }

    try {
      const bubbleDiv = await page.$('div.msg-bubble[contenteditable="true"]');
      if (bubbleDiv) {
        await page.evaluate((el, t) => {
          el.textContent = t;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, bubbleDiv, replyText);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) { console.warn('[PLUG PUPPETEER] Reply text warning:', e.message); }

    try {
      await page.click('button.save-btn');
    } catch (e) {
      try { await page.evaluate(() => downloadHD()); }
      catch (e2) { console.warn('[PLUG PUPPETEER] Button fallback failed:', e2.message); }
    }

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const pngs = fs.readdirSync(dlFolder)
        .filter(f => f.toLowerCase().endsWith('.png') && f !== 'context.png' && !f.startsWith('plug_fallback'));
      if (pngs.length) {
        const full = pngs.map(f => path.join(dlFolder, f));
        downloadedPath = full.reduce((a, b) =>
          fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs ? a : b
        );
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!downloadedPath) {
      const fb = path.join(dlFolder, 'plug_fallback.png');
      await page.screenshot({ path: fb, fullPage: true });
      downloadedPath = fb;
    }
  } catch (e) {
    console.error('[PLUG PUPPETEER] ERROR:', e.message);
    try {
      const ep = path.join(dlFolder, 'plug_error.png');
      const page = (await browser.pages())[0];
      await page.screenshot({ path: ep });
      downloadedPath = ep;
    } catch (_) {}
  } finally {
    await browser.close();
  }

  return downloadedPath;
}

async function generatePlugScene(plugMsg, msgsBefore, apiKey, tmpDir, sceneIdx, imageBaseDir) {
  const plugsaySpeaker  = plugMsg.plugsay_speaker;
  const plugsayText     = plugMsg.plugsay_text;
  const plugsayTtsText  = plugMsg.plugsay_tts_text || stripBlurMarkers(plugsayText);
  const plugsaySfx      = plugMsg.plugsay_sfx;
  const plugsaySilent   = plugMsg.plugsay_silent || false;
  const plugSpeaker     = plugMsg.speaker;
  const plugText        = plugMsg.text;
  const plugTtsText     = plugMsg.tts_text || stripBlurMarkers(plugText);
  const plugSilent      = plugMsg.plug_silent || false;

  console.log(`[PLUG] plugsay speaker=${plugsaySpeaker}: bubble='${plugsayText}'  tts='${plugsayTtsText}'`);
  console.log(`[PLUG] plug    speaker=${plugSpeaker}:    bubble='${plugText}'  tts='${plugTtsText}'`);

  const contextImg = await renderContextForPlug(msgsBefore);
  const dlFolder   = path.join(tmpDir, `plug_dl_${sceneIdx}`);
  fs.mkdirSync(dlFolder, { recursive: true });

  const ctxPath = path.join(dlFolder, 'context.png');
  if (contextImg) {
    const buf = contextImg.toBuffer('image/png');
    fs.writeFileSync(ctxPath, buf);
  } else {
    const blank = createCanvas(CHAT_W, 200);
    const bCtx  = blank.getContext('2d');
    bCtx.fillStyle = rgb(THEME.chat_bg);
    bCtx.fillRect(0, 0, CHAT_W, 200);
    fs.writeFileSync(ctxPath, blank.toBuffer('image/png'));
  }

  const plugImgPath = await runPlugSelenium(plugText, ctxPath, dlFolder);

  let plugPil;
  if (plugImgPath && fs.existsSync(plugImgPath)) {
    const meta = await sharp(plugImgPath).metadata();
    const newW = Math.round(meta.width  * PLUGAI_SCALE);
    const newH = Math.round(meta.height * PLUGAI_SCALE);
    plugPil = await loadImage(
      await sharp(plugImgPath).resize(newW, newH).toBuffer()
    );
  }

  const frame = createCanvas(W, H);
  const fCtx  = frame.getContext('2d');
  fCtx.fillStyle = BG_COLOR;
  fCtx.fillRect(0, 0, W, H);
  if (plugPil) {
    const px = Math.round((W - plugPil.width)  / 2);
    const py = Math.round((H - plugPil.height) / 2 - H * 0.05);
    fCtx.drawImage(plugPil, px, py);
  }

  let wavPlugsay = null;
  if (!plugsaySilent) {
    const mp3Say = path.join(tmpDir, `plug_${sceneIdx}_say.mp3`);
    wavPlugsay   = path.join(tmpDir, `plug_${sceneIdx}_say.wav`);
    await genAi33ProAudio(apiKey, plugsayTtsText, mp3Say, plugsaySpeaker);
    convertToWav(mp3Say, wavPlugsay);
  } else if (plugsaySfx) {
    const sfxPath = resolveSfxPath(plugsaySfx, imageBaseDir);
    if (sfxPath) {
      wavPlugsay = path.join(tmpDir, `plug_${sceneIdx}_say.wav`);
      convertToWav(sfxPath, wavPlugsay);
    }
  }

  let wavPlug = null;
  if (!plugSilent) {
    const mp3Reply = path.join(tmpDir, `plug_${sceneIdx}_reply.mp3`);
    wavPlug        = path.join(tmpDir, `plug_${sceneIdx}_reply.wav`);
    await genAi33ProAudio(apiKey, plugTtsText, mp3Reply, plugSpeaker);
    convertToWav(mp3Reply, wavPlug);
  }

  return { frame, wavPlugsay, wavPlug };
}

// =====================================================================
// PUPPETEER: RIZZ AI
// =====================================================================
async function runRizzSelenium(rizzReplyText, contextImgPath, dlFolder) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    defaultViewport: { width: 1920, height: 1080 },
  });
  let downloadedPath = null;

  try {
    const page = await browser.newPage();
    const cdp  = await page.target().createCDPSession();
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(dlFolder),
    });

    console.log(`[RIZZ PUPPETEER] Opening ${RIZZ_URL}`);
    await page.goto(RIZZ_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      const fi = await page.$('input[type="file"]');
      if (fi) { await fi.uploadFile(path.resolve(contextImgPath)); await new Promise(r => setTimeout(r, 2500)); }
    } catch (e) { console.warn('[RIZZ PUPPETEER] File upload warning:', e.message); }

    try {
      const ta = await page.$('textarea');
      if (ta) { await ta.click({ clickCount: 3 }); await ta.type(rizzReplyText); await new Promise(r => setTimeout(r, 800)); }
    } catch (e) { console.warn('[RIZZ PUPPETEER] Textarea warning:', e.message); }

    try {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => /screenshot|save|download/i.test(b.textContent));
        if (btn) btn.click();
      });
    } catch (e) {
      try { await page.evaluate(() => downloadHD()); }
      catch (e2) { console.warn('[RIZZ PUPPETEER] Button fallback failed:', e2.message); }
    }

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const pngs = fs.readdirSync(dlFolder)
        .filter(f => f.toLowerCase().endsWith('.png') && f !== 'context.png' && !f.startsWith('rizz_fallback'));
      if (pngs.length) {
        const full = pngs.map(f => path.join(dlFolder, f));
        downloadedPath = full.reduce((a, b) => fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs ? a : b);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!downloadedPath) {
      const fb = path.join(dlFolder, 'rizz_fallback.png');
      await page.screenshot({ path: fb, fullPage: true });
      downloadedPath = fb;
    }
  } catch (e) {
    console.error('[RIZZ PUPPETEER] ERROR:', e.message);
  } finally {
    await browser.close();
  }
  return downloadedPath;
}

async function buildRizzFrames(rizzImgPath) {
  const MASK_RADIUS = 15;
  const OFFSET_UP   = 200;
  const CROP_PX     = 4;

  let srcBuf = fs.readFileSync(rizzImgPath);
  let meta   = await sharp(srcBuf).metadata();
  let { width: w, height: h } = meta;

  srcBuf = await sharp(srcBuf).extract({
    left: CROP_PX, top: CROP_PX,
    width: w - 2 * CROP_PX, height: h - 2 * CROP_PX,
  }).toBuffer();
  w -= 2 * CROP_PX; h -= 2 * CROP_PX;

  const newW = Math.round(w * RIZZ_SCALE);
  const newH = Math.round(h * RIZZ_SCALE);
  srcBuf = await sharp(srcBuf).resize(newW, newH).ensureAlpha().toBuffer();

  const srcImg = await loadImage(srcBuf);

  const cardCanvas = createCanvas(newW, newH);
  const cCtx = cardCanvas.getContext('2d');
  roundedRect(cCtx, 0, 0, newW, newH, MASK_RADIUS);
  cCtx.clip();
  cCtx.drawImage(srcImg, 0, 0, newW, newH);

  const px = Math.round((W - newW) / 2);
  const py = Math.max(0, Math.round((H - newH) / 2) - OFFSET_UP);

  const bgFull = createCanvas(W, H);
  const fCtx   = bgFull.getContext('2d');
  fCtx.fillStyle = BG_COLOR;
  fCtx.fillRect(0, 0, W, H);
  fCtx.drawImage(cardCanvas, px, py);

  const revealH    = Math.round(newH * RIZZ_REVEAL_RATIO);
  const hideStartY = py + revealH;

  const bgPartial = createCanvas(W, H);
  const pCtx = bgPartial.getContext('2d');
  pCtx.drawImage(bgFull, 0, 0);
  pCtx.fillStyle = BG_COLOR;
  pCtx.fillRect(px, hideStartY, newW, py + newH - hideStartY);

  return { framePartial: bgPartial, frameFull: bgFull };
}

async function generateRizzScene(rizzMsg, msgsBefore, apiKey, tmpDir, sceneIdx, imageBaseDir) {
  const rizzsaySpeaker  = rizzMsg.rizzsay_speaker;
  const rizzsayText     = rizzMsg.rizzsay_text;
  const rizzsayTtsText  = rizzMsg.rizzsay_tts_text || stripBlurMarkers(rizzsayText);
  const rizzsaySfx      = rizzMsg.rizzsay_sfx;
  const rizzsaySilent   = rizzMsg.rizzsay_silent || false;
  const rizzSpeaker     = rizzMsg.speaker;
  const rizzText        = rizzMsg.text;
  const rizzTtsText     = rizzMsg.tts_text || stripBlurMarkers(rizzText);
  const rizzSilent      = rizzMsg.rizz_silent || false;

  const contextImg = await renderContextForPlug(msgsBefore);
  const dlFolder   = path.join(tmpDir, `rizz_dl_${sceneIdx}`);
  fs.mkdirSync(dlFolder, { recursive: true });

  const ctxPath = path.join(dlFolder, 'context.png');
  if (contextImg) {
    fs.writeFileSync(ctxPath, contextImg.toBuffer('image/png'));
  } else {
    const blank = createCanvas(CHAT_W, 200);
    const bCtx  = blank.getContext('2d');
    bCtx.fillStyle = rgb(THEME.chat_bg);
    bCtx.fillRect(0, 0, CHAT_W, 200);
    fs.writeFileSync(ctxPath, blank.toBuffer('image/png'));
  }

  const rizzImgPath = await runRizzSelenium(rizzText, ctxPath, dlFolder);

  let framePartial, frameFull;
  if (rizzImgPath && fs.existsSync(rizzImgPath)) {
    ({ framePartial, frameFull } = await buildRizzFrames(rizzImgPath));
  } else {
    const blank = createCanvas(W, H);
    const bCtx  = blank.getContext('2d');
    bCtx.fillStyle = BG_COLOR;
    bCtx.fillRect(0, 0, W, H);
    framePartial = blank;
    frameFull    = blank;
  }

  let wavRizzsay = null;
  if (!rizzsaySilent) {
    const mp3Say = path.join(tmpDir, `rizz_${sceneIdx}_say.mp3`);
    wavRizzsay   = path.join(tmpDir, `rizz_${sceneIdx}_say.wav`);
    await genAi33ProAudio(apiKey, rizzsayTtsText, mp3Say, rizzsaySpeaker);
    convertToWav(mp3Say, wavRizzsay);
  } else if (rizzsaySfx) {
    const sfxPath = resolveSfxPath(rizzsaySfx, imageBaseDir);
    if (sfxPath) {
      wavRizzsay = path.join(tmpDir, `rizz_${sceneIdx}_say.wav`);
      convertToWav(sfxPath, wavRizzsay);
    }
  }

  let wavRizz = null;
  if (!rizzSilent) {
    const mp3Reply = path.join(tmpDir, `rizz_${sceneIdx}_reply.mp3`);
    wavRizz        = path.join(tmpDir, `rizz_${sceneIdx}_reply.wav`);
    await genAi33ProAudio(apiKey, rizzTtsText, mp3Reply, rizzSpeaker);
    convertToWav(mp3Reply, wavRizz);
  }

  return { framePartial, frameFull, wavRizzsay, wavRizz };
}

// =====================================================================
// VIDEO ENCODING — EPIPE FIX APPLIED
// =====================================================================
async function writeVideoWithFfmpeg(frameCanvases, wavFiles, fps, outputPath) {
  const durations = wavFiles.map(w => getAudioDuration(w));
  const frameCounts = [];
  let cumulative = 0.0;
  let prevEndFrame = 0;
  for (const d of durations) {
    cumulative += d;
    const endFrame = Math.round(cumulative * fps);
    frameCounts.push(endFrame - prevEndFrame);
    prevEndFrame = endFrame;
  }
  const totalFrames = frameCounts.reduce((a, b) => a + b, 0);
  console.log(`[VIDEO] Encoding ${totalFrames} frames @ ${fps}fps`);

  // ── Write frames as JPEG (not PNG) to slash disk+RAM usage by ~10x ──
  // Each 1080x1920 PNG ≈ 2–6 MB; JPEG quality 95 ≈ 300–600 KB.
  // This keeps total disk use under ~300 MB for a 30-sec clip.
  const frameDir = outputPath + '_frames';
  fs.mkdirSync(frameDir, { recursive: true });

  try {
    let frameIdx = 0;
    let lastFrameJpeg = null;

    for (let si = 0; si < frameCanvases.length; si++) {
      const canvas = frameCanvases[si];
      if (canvas !== null) {
        // Convert canvas → JPEG buffer via sharp (much smaller than PNG)
        const pngBuf = canvas.toBuffer('image/png');
        lastFrameJpeg = await sharp(pngBuf)
          .jpeg({ quality: 95, mozjpeg: false })
          .toBuffer();
      }
      if (!lastFrameJpeg) continue;

      const count = frameCounts[si] || 0;
      for (let f = 0; f < count; f++) {
        const framePath = path.join(frameDir, `frame_${String(frameIdx).padStart(6, '0')}.jpg`);
        fs.writeFileSync(framePath, lastFrameJpeg);
        frameIdx++;
      }
    }

    console.log(`[VIDEO] Wrote ${frameIdx} JPEG frames, now encoding...`);

    const ffmpegBin = (() => {
      try { return _exec('which ffmpeg').toString().trim(); } catch (_) { return 'ffmpeg'; }
    })();

    // -threads 2 keeps ffmpeg's RAM footprint low on Railway free tier
    const r = spawnSync(ffmpegBin, [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(frameDir, 'frame_%06d.jpg'),
      '-vcodec', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-threads', '2',
      outputPath,
    ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

    if (r.status !== 0 || r.signal) {
      console.error('[VIDEO] ffmpeg stderr:', (r.stderr || '').slice(-3000));
      throw new Error(`ffmpeg encode failed: status=${r.status} signal=${r.signal}`);
    }

    console.log('[VIDEO] Encode complete.');
    return outputPath;

  } finally {
    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function muxVideoAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-shortest', outputPath,
    ];
    const ff = spawn('ffmpeg', args);
    ff.stderr.on('data', d => process.stderr.write(d));
    ff.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`mux failed: ${code}`)));
  });
}

// =====================================================================
// SILENCE REMOVAL
// =====================================================================
function getVideoInfo(videoPath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', videoPath,
  ], { encoding: 'utf8' });
  const data = JSON.parse(r.stdout);
  const vs   = data.streams.find(s => s.codec_type === 'video');
  const [num, den] = vs.r_frame_rate.split('/');
  return {
    fps:      parseFloat(num) / parseFloat(den),
    width:    parseInt(vs.width),
    height:   parseInt(vs.height),
    duration: parseFloat(data.format.duration),
  };
}

function detectNonsilentRanges(audioPath, minSilenceLen = 160, silenceThresh = -60) {
  const r = spawnSync('ffmpeg', [
    '-i', audioPath,
    '-af', `silencedetect=n=${silenceThresh}dB:d=${minSilenceLen / 1000}`,
    '-f', 'null', '-',
  ], { encoding: 'utf8' });

  const output  = r.stderr || '';
  const silStart = [];
  const silEnd   = [];

  for (const line of output.split('\n')) {
    const ms = line.match(/silence_start:\s*([\d.]+)/);
    const me = line.match(/silence_end:\s*([\d.]+)/);
    if (ms) silStart.push(parseFloat(ms[1]));
    if (me) silEnd.push(parseFloat(me[1]));
  }

  const duration = getAudioDuration(audioPath);
  const silRanges = [];
  const n = Math.min(silStart.length, silEnd.length);
  for (let i = 0; i < n; i++) silRanges.push([silStart[i], silEnd[i]]);

  const speech = [];
  let cursor = 0.0;
  for (const [ss, se] of silRanges) {
    if (cursor < ss) speech.push([cursor, ss]);
    cursor = se;
  }
  if (cursor < duration) speech.push([cursor, duration]);
  return speech;
}

async function removeSilenceFromVideo(inputVideo, outputVideo, protectedRangesSec = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence_'));

  try {
    const info = getVideoInfo(inputVideo);
    const { fps, width, height, duration } = info;
    console.log(`\n=== SILENCE REMOVAL ===`);
    console.log(`📹 ${width}x${height} @ ${fps.toFixed(2)}fps  |  ${duration.toFixed(1)}s`);

    const audioWav = path.join(tmpDir, 'audio.wav');
    spawnSync('ffmpeg', ['-y', '-i', inputVideo, '-vn', '-ac', '1', '-ar', '16000', audioWav]);

    let keepRanges;
    if (!protectedRangesSec || protectedRangesSec.length === 0) {
      const speech = detectNonsilentRanges(audioWav);
      const keepMs = 0.08;
      keepRanges = [];
      for (const [s, e] of speech) {
        const rs = Math.max(0,        s - keepMs);
        const re = Math.min(duration, e + keepMs);
        if (keepRanges.length && rs <= keepRanges[keepRanges.length - 1][1]) {
          keepRanges[keepRanges.length - 1][1] = Math.max(keepRanges[keepRanges.length - 1][1], re);
        } else {
          keepRanges.push([rs, re]);
        }
      }
    } else {
      console.log(`🔒 Protected ranges: ${JSON.stringify(protectedRangesSec)}`);
      const prot = protectedRangesSec.slice().sort((a, b) => a[0] - b[0]);
      const slabs = [];
      let cursor = 0.0;
      for (const [ps, pe] of prot) {
        if (cursor < ps) slabs.push({ start: cursor, end: ps, protected: false });
        slabs.push({ start: ps, end: pe, protected: true });
        cursor = pe;
      }
      if (cursor < duration) slabs.push({ start: cursor, end: duration, protected: false });

      keepRanges = [];
      for (const slab of slabs) {
        if (slab.protected) {
          keepRanges.push([slab.start, slab.end]);
        } else {
          const slabWav = path.join(tmpDir, `slab_${slab.start.toFixed(3)}.wav`);
          spawnSync('ffmpeg', [
            '-y', '-i', audioWav,
            '-ss', String(slab.start), '-to', String(slab.end),
            slabWav,
          ]);
          const speech = detectNonsilentRanges(slabWav);
          const keepMs = 0.08;
          for (const [s, e] of speech) {
            const rs = Math.max(slab.start, slab.start + s - keepMs);
            const re = Math.min(slab.end,   slab.start + e + keepMs);
            if (keepRanges.length && rs <= keepRanges[keepRanges.length - 1][1]) {
              keepRanges[keepRanges.length - 1][1] = Math.max(keepRanges[keepRanges.length - 1][1], re);
            } else {
              keepRanges.push([rs, re]);
            }
          }
        }
      }
    }

    const keptTotal = keepRanges.reduce((a, [s, e]) => a + (e - s), 0);
    console.log(`🔇 Total kept: ${keptTotal.toFixed(2)}s / ${duration.toFixed(2)}s`);

    if (keepRanges.length === 0) {
      fs.copyFileSync(inputVideo, outputVideo);
      return outputVideo;
    }

    const selectExpr = keepRanges.map(([s, e]) => `between(t,${s},${e})`).join('+');

    const r = spawnSync('ffmpeg', [
      '-y', '-i', inputVideo,
      '-vf', `select='${selectExpr}',setpts=N/FRAME_RATE/TB`,
      '-af', `aselect='${selectExpr}',asetpts=N/SR/TB`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      outputVideo,
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

    if (r.status !== 0) {
      console.error('[SILENCE REMOVAL] ffmpeg error:', r.stderr);
      fs.copyFileSync(inputVideo, outputVideo);
    }

    console.log(`✅ Silence-removed output: ${outputVideo}`);
    return outputVideo;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// =====================================================================
// MAIN RUNNER
// =====================================================================
async function runTextingVideo(scriptPath, imageBaseDir, apiKey, sentSfxPath, receivedSfxPath) {
  const savedImageBaseDir = IMAGE_BASE_DIR;
  IMAGE_BASE_DIR = imageBaseDir;
  TTS_CACHE_DIR  = path.join(imageBaseDir, 'tts_cache');
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

  const { unreadCount, uiCornerRadius, threads } = parseFileSettingsAndThreads(scriptPath);
  if (!threads.length) throw new Error('No conversations found in input!');

  const scenesData           = [];
  const wavFiles             = [];
  const messageTimeline      = [];
  let curT                   = 0.0;
  const breakProtectedRanges = [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texting_video_'));
  const tag    = THEME.filename_tag;

  let counter = 1;
  let rawOutputFile, finalOutputFile;
  do {
    rawOutputFile   = path.join(imageBaseDir, `textingAiVR_1080p_${tag}_${String(counter).padStart(3,'0')}_raw.mp4`);
    finalOutputFile = path.join(imageBaseDir, `textingAiVR_1080p_${tag}_${String(counter).padStart(3,'0')}.mp4`);
    counter++;
  } while (fs.existsSync(finalOutputFile));

  console.log(`Will save final video as: ${finalOutputFile}`);

  try {
    console.log('\n=== BUILDING SCENES ===');
    let sceneIdx         = 0;
    const allRenderedMsgs = [];

    for (const thread of threads) {
      const { contact, messages: msgs, avatar: avatarFile } = thread;
      if (!msgs.length) continue;

      let start = 0;
      while (start < msgs.length) {
        const tentativeWindow = msgs.slice(start, start + PAGE_SIZE_TEXT);
        const hasImage = tentativeWindow.some(m =>
          !m.is_plug && !m.is_break && isImageMessage(stripBlurMarkers(m.text || ''))[0]
        );
        const pageSize = hasImage ? PAGE_SIZE_WITH_IMAGE : PAGE_SIZE_TEXT;
        const window   = msgs.slice(start, start + pageSize);

        const showPoster = (start === 0);
        const poster     = showPoster ? await createContactHeader(contact, unreadCount, avatarFile) : null;

        const { clips: fullBubbles, widths: fullWs, heights: fullHs, senders: fullSnd, isImgFlags: fullIsImg }
          = await makeBubbleClips(window);

        for (let i = 1; i <= window.length; i++) {
          const bclips   = fullBubbles.slice(0, i);
          const ws       = fullWs.slice(0, i);
          const hs       = fullHs.slice(0, i);
          const snd      = fullSnd.slice(0, i);
          const imgFlags = fullIsImg.slice(0, i);

          const last         = window[i - 1];
          const lastIsImage  = imgFlags[imgFlags.length - 1];
          const lastSender   = snd[snd.length - 1];
          const sfxName      = last.sfx;
          const isAudioOnly  = last.audio_only || false;
          const isPlug       = last.is_plug     || false;
          const isRizz       = last.is_rizz     || false;
          const isBreak      = last.is_break    || false;
          const ttsText      = last.tts_text || stripBlurMarkers(last.text || '');

          if (isBreak) {
            const brkDur = last.duration_s;
            const wavBrk = path.join(tmpDir, `scene_${String(sceneIdx).padStart(4,'0')}_break.wav`);
            generateSilentWav(brkDur, wavBrk);
            const actualDur = getAudioDuration(wavBrk);
            scenesData.push(null);
            wavFiles.push(wavBrk);
            breakProtectedRanges.push([curT, curT + actualDur]);
            messageTimeline.push({ text: `<break:${brkDur}s>`, start: curT, end: curT + actualDur, is_break: true });
            curT += actualDur;
            sceneIdx++;
            continue;
          }

          if (isPlug) {
            const { frame: plugFrame, wavPlugsay, wavPlug } = await generatePlugScene(
              last, allRenderedMsgs, apiKey, tmpDir, sceneIdx, imageBaseDir
            );
            if (wavPlugsay) {
              const durSay = getAudioDuration(wavPlugsay);
              scenesData.push(plugFrame); wavFiles.push(wavPlugsay);
              messageTimeline.push({ text: last.plugsay_text, start: curT, end: curT + durSay });
              curT += durSay; sceneIdx++;
            }
            if (wavPlug) {
              const durReply = getAudioDuration(wavPlug);
              scenesData.push(null); wavFiles.push(wavPlug);
              messageTimeline.push({ text: last.text, start: curT, end: curT + durReply });
              curT += durReply; sceneIdx++;
            }
            continue;
          }

          if (isRizz) {
            const { framePartial, frameFull, wavRizzsay, wavRizz } = await generateRizzScene(
              last, allRenderedMsgs, apiKey, tmpDir, sceneIdx, imageBaseDir
            );
            if (wavRizzsay) {
              const durSay = getAudioDuration(wavRizzsay);
              scenesData.push(framePartial); wavFiles.push(wavRizzsay);
              messageTimeline.push({ text: last.rizzsay_text, start: curT, end: curT + durSay });
              curT += durSay; sceneIdx++;
            }
            if (wavRizz) {
              const durReply = getAudioDuration(wavRizz);
              scenesData.push(frameFull); wavFiles.push(wavRizz);
              messageTimeline.push({ text: last.text, start: curT, end: curT + durReply });
              curT += durReply; sceneIdx++;
            }
            continue;
          }

          const isDotsOnly = /^[.\s…]+$/.test(last.text || '');

          let ttsMp3;
          if (lastIsImage || isDotsOnly) {
            ttsMp3 = lastSender === 'me' ? sentSfxPath : receivedSfxPath;
          } else {
            ttsMp3 = path.join(tmpDir, `${contact}_${start}_${i}_tts.mp3`);
            await genAi33ProAudio(apiKey, ttsText, ttsMp3, last.speaker);
          }

          if (sfxName) {
            const sfxFile = resolveSfxPath(sfxName, imageBaseDir);
            if (sfxFile) {
              const combinedMp3 = path.join(tmpDir, `${contact}_${start}_${i}_combined.mp3`);
              const listFile    = path.join(tmpDir, `${contact}_${start}_${i}_concat.txt`);
              fs.writeFileSync(listFile,
                `file '${path.resolve(ttsMp3)}'\nfile '${path.resolve(sfxFile)}'\n`
              );
              const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', combinedMp3], { encoding: 'utf8' });
              fs.unlinkSync(listFile);
              if (r.status === 0) ttsMp3 = combinedMp3;
            }
          }

          const wavFile = path.join(tmpDir, `scene_${String(sceneIdx).padStart(4,'0')}.wav`);
          convertToWav(ttsMp3, wavFile);
          const duration = getAudioDuration(wavFile);
          wavFiles.push(wavFile);

          let sceneImg = null;
          if (!isAudioOnly) {
            sceneImg = await createSceneImage(bclips, ws, hs, snd, poster, showPoster, uiCornerRadius);
          }
          scenesData.push(sceneImg);
          allRenderedMsgs.push(last);

          messageTimeline.push({ text: last.text, start: curT, end: curT + duration, sfx: sfxName, audio_only: isAudioOnly });
          curT += duration;
          sceneIdx++;

          console.log(`[SCENE ${sceneIdx}] WAV: ${path.basename(wavFile)}, Duration: ${duration.toFixed(4)}s`);
        }

        start += pageSize;
      }
    }

    console.log(`\n[INFO] Total scenes: ${scenesData.length} | WAVs: ${wavFiles.length} | Duration: ${curT.toFixed(4)}s`);

    const finalAudio = path.join(tmpDir, 'final_audio.wav');
    concatWavFiles(wavFiles, finalAudio);

    const videoNoAudio = rawOutputFile.replace('.mp4', '_videoonly.mp4');
    await writeVideoWithFfmpeg(scenesData, wavFiles, 30, videoNoAudio);

    await muxVideoAudio(videoNoAudio, finalAudio, rawOutputFile);
    if (fs.existsSync(videoNoAudio)) fs.unlinkSync(videoNoAudio);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    IMAGE_BASE_DIR = savedImageBaseDir;
  }

  const finalOutput = await removeSilenceFromVideo(
    rawOutputFile, finalOutputFile,
    breakProtectedRanges.length ? breakProtectedRanges : null
  );

  if (fs.existsSync(rawOutputFile)) fs.unlinkSync(rawOutputFile);
  console.log(`\n✅ ${tag.toUpperCase()} final video (silence removed): ${finalOutput}`);
  return { outputVideo: finalOutput, messageTimeline };
}

// =====================================================================
// ENTRY POINT
// =====================================================================
async function main() {
  const themeKey = await askTheme();
  THEME = THEMES[themeKey];
  console.log(`\n[THEME] Selected: ${themeKey.toUpperCase()}\n`);

  const args = process.argv.slice(2);
  const scriptFile        = args[0] || 'btest.txt';
  const baseImageDir      = args[1] || '.';
  const elevenlabsApiKey  = args[2] || 'api';
  const sentSfx           = args[3] || SENT_SFX_DEFAULT;
  const receivedSfx       = args[4] || RECEIVED_SFX_DEFAULT;

  const { outputVideo, messageTimeline } = await runTextingVideo(
    scriptFile, baseImageDir, elevenlabsApiKey, sentSfx, receivedSfx
  );

  console.log(`Output video: ${outputVideo}`);
  return { outputVideo, messageTimeline };
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  runTextingVideo, parseFileSettingsAndThreads, genAi33ProAudio,
  bubbleCanvas, createContactHeader, createSceneImage,
  stripBlurMarkers, extractBlurRuns, parseTtsOverride,
  THEMES, AI33PRO_VOICE_MAP,
};