/*
 * lib/ai.js - AI engine 100% lokal (offline)
 * - Whisper (whisper-base) : transkripsi suara -> teks + timestamp per kata
 * - Qwen 1.5 0.5B Chat     : analisis momen paling viral dari transkrip
 * Model di-download SEKALI ke folder userData lalu dipakai selamanya offline.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let asrPipe = null;
let llmPipe = null;
let _modelsDir = null;
let MODEL_IDS = { asr: 'Xenova/whisper-base', llm: 'Xenova/Qwen1.5-0.5B-Chat' };

/*
 * @xenova/transformers 2.x adalah paket ESM murni -> TIDAK BOLEH require().
 * Harus pakai dynamic import(). Di aplikasi terpaket (app.asar), resolver ESM
 * Node/Electron bisa gagal membaca dalam arsip, jadi kita langsung impor file
 * aslinya dari app.asar.unpack (di-disk) sebagai kandidat utama.
 */
let _tfMod = null;
let _tfFile = null; // path file transformers.js di disk (diteruskan ke child process)

async function loadTransformers() {
  if (_tfMod) return _tfMod;
  const rel = path.join('node_modules', '@xenova', 'transformers', 'src', 'transformers.js');
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', rel));
  candidates.push(path.join(__dirname, '..', rel));
  const errors = [];
  // 1) Impor langsung file di disk (paling andal, bekerja di dev & terpaket)
  for (const file of candidates) {
    if (!fs.existsSync(file)) { errors.push(file + ' (tidak ada)'); continue; }
    try {
      _tfMod = await import(pathToFileURL(file).href);
      _tfFile = file;
      return _tfMod;
    } catch (e) {
      errors.push(file + ': ' + String(e && e.message || e).slice(0, 140));
    }
  }
  // 2) Fallback: bare specifier
  try {
    _tfMod = await import('@xenova/transformers');
    return _tfMod;
  } catch (e) {
    errors.push('bare import: ' + String(e && e.message || e).slice(0, 140));
  }
  throw new Error('Gagal memuat library AI lokal (transformers.js). Detail: ' + errors.join(' || '));
}

async function init(modelsDir, modelIds) {
  const { env } = await loadTransformers();
  fs.mkdirSync(modelsDir, { recursive: true });
  env.cacheDir = modelsDir;
  env.localModelPath = modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // dipakai hanya saat download pertama
  _modelsDir = modelsDir;
  if (modelIds) MODEL_IDS = modelIds;
}

async function ensureASR(onProgress) {
  if (asrPipe) return asrPipe;
  const { pipeline } = await loadTransformers();
  const cb = (p) => {
    if (onProgress) onProgress(Object.assign({ model: 'asr' }, p));
  };
  asrPipe = await pipeline('automatic-speech-recognition', MODEL_IDS.asr, {
    quantized: true,
    progress_callback: cb
  });
  return asrPipe;
}

async function ensureLLM(onProgress) {
  if (llmPipe) return llmPipe;
  const { pipeline } = await loadTransformers();
  const cb = (p) => {
    if (onProgress) onProgress(Object.assign({ model: 'llm' }, p));
  };
  llmPipe = await pipeline('text-generation', MODEL_IDS.llm, {
    quantized: true,
    progress_callback: cb
  });
  return llmPipe;
}

/* ---------- Audio decode (WAV 16k mono -> Float32Array) ---------- */
function loadWavAsFloat32(wavPath) {
  const wavefile = require('wavefile');
  const wav = new wavefile.WaveFile(fs.readFileSync(wavPath));
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples;
}

/* ---------- Transkripsi per chunk 60 detik ---------- */
async function transcribeWavChunks(chunkPaths, onChunkDone) {
  const asr = await ensureASR();
  const words = [];
  for (let i = 0; i < chunkPaths.length; i++) {
    const offset = i * 60; // tiap chunk 60 detik
    let out = null;
    try {
      const audio = loadWavAsFloat32(chunkPaths[i]);
      try {
        out = await asr(audio, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5,
          task: 'transcribe',
          language: 'indonesian'
        });
      } catch (e1) {
        out = await asr(audio, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5,
          task: 'transcribe'
        });
      }
    } catch (e2) {
      out = null;
    }
    if (out && out.chunks) {
      for (const c of out.chunks) {
        const ts = c.timestamp || [0, 0];
        const w = {
          text: String(c.text || '').trim(),
          start: (Number(ts[0]) || 0) + offset,
          end: (ts[1] == null ? (Number(ts[0]) || 0) + 0.4 : Number(ts[1])) + offset
        };
        if (w.text) words.push(w);
      }
    }
    if (onChunkDone) onChunkDone(i + 1, chunkPaths.length);
  }
  return words;
}

/* ---------- Kelompokkan kata -> segmen untuk prompt ---------- */
function wordsToSegments(words, maxSpan = 6.0, maxWords = 26) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    if (!cur) cur = { start: w.start, end: w.end, words: [w.text] };
    else {
      cur.end = w.end;
      cur.words.push(w.text);
    }
    if (cur.end - cur.start >= maxSpan || cur.words.length >= maxWords) {
      segs.push({ start: cur.start, end: cur.end, text: cur.words.join(' ') });
      cur = null;
    }
  }
  if (cur) segs.push({ start: cur.start, end: cur.end, text: cur.words.join(' ') });
  return segs;
}

/* ---------- Analisis LLM: pilih momen viral ---------- */
const HOOK_WORDS_ID = [
  'rahasia', 'cara', 'trik', 'tips', 'wow', 'gila', 'auto', 'gratis', 'jangan',
  'ternyata', 'penting', 'terbesar', 'pertama', 'paling', 'bukti', 'mulai',
  'salah', 'benar', 'tahukah', 'ingin', 'butuh', 'cuan', 'uang', 'banyak',
  'cepat', 'mudah', 'pertanyaan', 'jawaban', 'hati', 'takut', 'berani'
];
const HOOK_WORDS_EN = [
  'secret', 'how', 'why', 'best', 'never', 'always', 'money', 'free', 'biggest',
  'first', 'mistake', 'stop', 'start', 'everyone', 'nobody', 'hack', 'truth'
];

function scoreSegment(seg) {
  const t = seg.text.toLowerCase();
  let s = 0;
  for (const k of HOOK_WORDS_ID) if (t.includes(k)) s += 2;
  for (const k of HOOK_WORDS_EN) if (t.includes(k)) s += 2;
  if (/\?/.test(t)) s += 3;
  if (/\d/.test(t)) s += 2;
  if (t.split(/\s+/).length > 12) s += 1;
  return s;
}

function heuristicMoments(segments, videoDuration, targetSec, maxClips) {
  const scored = segments.map((s) => ({ seg: s, score: scoreSegment(s) }));
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const it of scored) {
    if (picked.length >= maxClips) break;
    const start = Math.max(0, Math.floor(it.seg.start) - Math.floor(targetSec * 0.15));
    let end = start + targetSec;
    if (end > videoDuration) end = videoDuration;
    if (end - start < 8) continue;
    const overlap = picked.some((m) => !(end <= m.start || start >= m.end));
    if (overlap) continue;
    const title = it.seg.text.split(/\s+/).slice(0, 6).join(' ');
    picked.push({ start, end, title });
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

function clampMoments(list, videoDuration, targetSec, maxClips) {
  const out = [];
  const sorted = (list || [])
    .map((m) => ({
      start: Math.max(0, Number(m.start) || 0),
      end: Number(m.end) || 0,
      title: String(m.title || 'Klip Viral').slice(0, 60)
    }))
    .sort((a, b) => a.start - b.start);
  for (const m of sorted) {
    if (out.length >= maxClips) break;
    let { start, end } = m;
    if (!isFinite(end) || end <= start) end = start + targetSec;
    if (end - start > targetSec * 1.9) end = start + Math.floor(targetSec * 1.5);
    if (end - start < 8) end = Math.min(start + targetSec, videoDuration);
    if (end > videoDuration) {
      end = videoDuration;
      start = Math.max(0, end - Math.min(targetSec, end));
    }
    if (end - start < 8) continue;
    const overlap = out.some((x) => !(end <= x.start + 0.5 || start >= x.end - 0.5));
    if (overlap) continue;
    out.push({ start: Math.floor(start), end: Math.floor(end), title: m.title });
  }
  return out;
}

function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).replace(/<\|im_end\|>/g, '').trim();
  const firstBracket = t.indexOf('[');
  if (firstBracket === -1) return null;
  t = t.slice(firstBracket);
  let depth = 0;
  let endIdx = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) return null;
  const candidate = t.slice(0, endIdx + 1);
  try { return JSON.parse(candidate); } catch (e) {}
  try { return JSON.parse(candidate.replace(/,\s*([\]}])/g, '$1')); } catch (e) {}
  const objs = candidate.match(/\{[^{}]*\}/g);
  if (objs) {
    const arr = [];
    for (const o of objs) {
      try { arr.push(JSON.parse(o)); } catch (e) {}
    }
    if (arr.length) return arr;
  }
  return null;
}

function buildLLMPrompt(segments, targetSec, maxClips) {
  const lines = [];
  let total = 0;
  // Batasi prompt agar RAM aman di PC 8GB (logits vocab Qwen 151k sangat besar)
  const LIMIT = 1400;
  for (const s of segments) {
    const line = `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`;
    if (total + line.length > LIMIT) break;
    lines.push(line);
    total += line.length;
  }
  const sys = 'You are a viral video editor AI. Reply with ONLY a valid JSON array. No explanation.';
  const usr =
    `Pick the ${maxClips} most viral, attention-grabbing moments from this video transcript. ` +
    `Each clip must be about ${targetSec} seconds long. Moments must not overlap and must be in chronological order. ` +
    `Reply ONLY with a JSON array like: [{"start":12,"end":42,"title":"short catchy title"}] . ` +
    `The "title" must be in the same language as the transcript, max 6 words.\n\n` +
    `Transcript with timestamps (seconds):\n` + lines.join('\n');
  return (
    `<|im_start|>system\n${sys}<|im_end|>\n` +
    `<|im_start|>user\n${usr}<|im_end|>\n` +
    `<|im_start|>assistant\n[{"start":`
  );
}

/* ---------- LLM di CHILD PROCESS terisolasi (tahan OOM) ---------- */
function runLLMInChild(prompt, maxNewTokens, opts = {}) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'llm_worker.js')],
      {
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: '1',
          CCP_MODELS_DIR: _modelsDir || '',
          CCP_MODEL_ID: MODEL_IDS.llm,
          CCP_TF_FILE: _tfFile || ''
        }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      }
    );
    if (opts.registerChild) opts.registerChild(child);

    let out = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve(val);
    };
    // Timeout 8 menit: pada PC lambat generasi bisa lama, tapi jangan selamanya
    const timer = setTimeout(() => finish(null), 480000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(null));
    child.on('close', (code, signal) => {
      const idx = out.indexOf('###CCP_RESULT###');
      if (idx !== -1) {
        try {
          const parsed = JSON.parse(out.slice(idx + '###CCP_RESULT###'.length).trim());
          if (parsed && parsed.ok) return finish({ text: parsed.text });
          return finish(null);
        } catch (e) { return finish(null); }
      }
      // Tanpa marker: child mati (mis. OOM kill) -> return null
      finish(null);
    });

    try {
      child.stdin.write(JSON.stringify({ prompt, maxNewTokens: maxNewTokens || 220 }));
      child.stdin.end();
    } catch (e) { finish(null); }
  });
}

async function analyzeMoments(segments, videoDuration, targetSec, maxClips, onLog, opts = {}) {
  if (!segments.length) return [];
  try {
    if (onLog) onLog('AI sedang menganalisis transkrip (lokal, tanpa internet)...');
    const prompt = buildLLMPrompt(segments, targetSec, maxClips);
    const res = await runLLMInChild(prompt, 220, opts);
    let parsed = null;
    if (res && res.text) {
      parsed = extractJsonArray('[{"start":' + res.text);
      if (!parsed) parsed = extractJsonArray(res.text);
    }
    if (parsed && parsed.length) {
      const clamped = clampMoments(parsed, videoDuration, targetSec, maxClips);
      if (clamped.length) {
        if (onLog) onLog(`AI memilih ${clamped.length} momen viral.`);
        return clamped;
      }
    }
    if (onLog) onLog('Output AI tidak terbaca/memori tidak cukup, memakai analisis heuristik...');
  } catch (err) {
    if (onLog) onLog('AI gagal (' + String(err && err.message || err).slice(0, 80) + '), memakai heuristik...');
  }
  return heuristicMoments(segments, videoDuration, targetSec, maxClips);
}

module.exports = {
  init,
  ensureASR,
  ensureLLM,
  loadTransformers,
  runLLMInChild,
  transcribeWavChunks,
  wordsToSegments,
  analyzeMoments,
  heuristicMoments,
  clampMoments,
  extractJsonArray,
  loadWavAsFloat32,
  MODEL_IDS
};
