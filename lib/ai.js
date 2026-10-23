/*
 * lib/ai.js - AI engine 100% lokal (offline)
 * - Whisper (whisper-base) : transkripsi suara -> teks + timestamp per kata
 * - Qwen 1.5 0.5B Chat     : analisis momen paling viral dari transkrip
 * Model di-download SEKALI ke folder userData lalu dipakai selamanya offline.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const asrPipes = {}; // modelId -> pipeline (bisa beberapa model sekaligus)
let llmPipe = null;
let _modelsDir = null;
let MODEL_IDS = { asr: 'Xenova/whisper-base', llm: 'Xenova/Qwen1.5-0.5B-Chat' };

function asrProgressKey(modelId) {
  if (/tiny/i.test(modelId)) return 'tiny';
  if (/small/i.test(modelId)) return 'small';
  return 'asr';
}

/*
 * @xenova/transformers 2.x adalah paket ESM murni -> TIDAK BOLEH require().
 * Harus pakai dynamic import(). Di aplikasi terpaket (app.asar), resolver ESM
 * Node/Electron bisa gagal membaca dalam arsip, jadi kita langsung impor file
 * aslinya dari app.asar.unpack (di-disk) sebagai kandidat utama.
 */
let _tfMod = null;
let _tfFile = null; // path file transformers.js di disk (diteruskan ke child process)

/* ----------
 * Hemat RAM untuk onnxruntime-node:
 *  - enableCpuMemArena:false  -> arena memori CPU dimatikan (puncak RAM turun ~1-2GB)
 *  - intra_op_num_threads:2   -> buffer scratch lebih kecil, tetap cukup cepat
 * Ini penting agar Whisper Small tetap aman dipakai di PC RAM 8GB.
 * ---------- */
function patchOrtMemorySaver(ort) {
  try {
    if (ort && ort.InferenceSession && typeof ort.InferenceSession.create === 'function' && !ort.__ccpMemSaver) {
      const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
      ort.InferenceSession.create = async (buffer, opts = {}) => origCreate(buffer, Object.assign({}, opts, {
        enableCpuMemArena: false,
        intra_op_num_threads: 2,
        inter_op_num_threads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: opts.graphOptimizationLevel || 'all'
      }));
      ort.__ccpMemSaver = true;
    }
  } catch (e) { /* kalau gagal, biarkan default */ }
}

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
      try {
        // onnxruntime-node diimpor langsung (CJS) supaya patch juga berlaku untuk worker child
        patchOrtMemorySaver(require('onnxruntime-node'));
      } catch (e) {}
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

/*
 * ensureASR(modelId, onProgress)  -- versi baru
 * ensureASR(onProgress)           -- kompatibel versi lama (pakai MODEL_IDS.asr)
 */
async function ensureASR(modelIdOrProgress, maybeProgress) {
  let modelId = MODEL_IDS.asr;
  let onProgress = null;
  if (typeof modelIdOrProgress === 'string') {
    modelId = modelIdOrProgress;
    onProgress = typeof maybeProgress === 'function' ? maybeProgress : null;
  } else if (typeof modelIdOrProgress === 'function') {
    onProgress = modelIdOrProgress;
  }
  if (asrPipes[modelId]) return asrPipes[modelId];
  const { pipeline } = await loadTransformers();
  const key = asrProgressKey(modelId);
  const cb = (p) => {
    if (onProgress) onProgress(Object.assign({ model: key }, p));
  };
  asrPipes[modelId] = await pipeline('automatic-speech-recognition', modelId, {
    quantized: true,
    progress_callback: cb
  });
  return asrPipes[modelId];
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

/* ---------- Deteksi suara sederhana (RMS per detik) ---------- */
function chunkHasSpeech(samples) {
  try {
    const win = 16000; // 1 detik
    let speechWin = 0;
    for (let i = 0; i + 8000 <= samples.length; i += win) {
      let sum = 0;
      const end = i + win;
      for (let j = i; j < end; j++) sum += samples[j] * samples[j];
      if (Math.sqrt(sum / win) > 0.0045) speechWin++;
      if (speechWin >= 2) return true; // minimal ~2 detik konten terdengar
    }
    return speechWin >= 2;
  } catch (e) { return true; } // ragu -> transkrip saja
}

/* ---------- Segmen (timestamp level segmen, tanpa DTW kata) -> kata ---------- */
function segmentsToWords(chunks, offset) {
  const words = [];
  for (const c of chunks || []) {
    const ts = c.timestamp || [0, 0];
    const s0 = (Number(ts[0]) || 0) + offset;
    const e0 = (ts[1] == null ? (Number(ts[0]) || 0) + 2 : Number(ts[1])) + offset;
    const parts = String(c.text || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const span = Math.max(0.25, e0 - s0);
    const per = span / parts.length;
    let t = s0;
    for (const wtext of parts) {
      words.push({ text: wtext, start: t, end: Math.min(e0, t + per) });
      t += per;
    }
  }
  return words;
}

/* ----------
 * Transkripsi CEPAT & PARALEL:
 *  - beberapa worker sekaligus (1 pipeline per worker) sesuai jumlah core CPU
 *  - bagian sunyi/hening di-skip tanpa diproses AI
 *  - timestamp level segmen (jauh lebih murah daripada DTW per kata),
 *    lalu timing kata dibagi proporsional di dalam segmen (cukup untuk subtitle karaoke)
 *  - model dipilih lewat opts.modelId (whisper-tiny = cepat, whisper-base = akurat)
 * ---------- */
/* ----------
 * Transkripsi CEPAT & PARALEL:
 *  - whisper-small (akurat): dijalankan di CHILD PROCESS terisolasi (RAM ~3,5GB).
 *    Kalau RAM komputer tidak cukup dan child mati (OOM), otomatis fallback
 *    ke whisper-base yang jauh lebih hemat memori -> aplikasi tidak pernah crash.
 *  - whisper-base/tiny (cepat): paralel dalam proses utama (1 pipeline per worker)
 *  - bagian sunyi/hening di-skip tanpa diproses AI
 *  - timestamp level segmen (jauh lebih murah daripada DTW kata),
 *    lalu timing kata dibagi proporsional di dalam segmen (cukup untuk subtitle karaoke)
 * ---------- */
const ASR_MARK_CHUNK = '###CCP_CHUNK###';
const ASR_MARK_RESULT = '###CCP_RESULT###';
const ASR_MARK_PROG = '###CCP_PROG###';

function spawnASRChild(registerChild) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'asr_worker.js')], {
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      CCP_TF_FILE: _tfFile || ''
    }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  if (registerChild) registerChild(child);
  return child;
}

/*
 * Pastikan file model ASR tersedia (download kalau perlu) TANPA menyimpan
 * pipeline di proses utama. Model besar (whisper-small) dimuat & dilepas di
 * child process -> RAM aplikasi utama tetap kecil.
 */
function ensureASRReady(modelId, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawnASRChild(null);
    let buf = '';
    let resultSeen = false;
    let resultOk = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const ln of lines) {
        if (ln.startsWith(ASR_MARK_PROG)) {
          try { if (onProgress) onProgress(JSON.parse(ln.slice(ASR_MARK_PROG.length))); } catch (e) {}
        } else if (ln.startsWith(ASR_MARK_RESULT)) {
          resultSeen = true;
          try { resultOk = !!JSON.parse(ln.slice(ASR_MARK_RESULT.length)).ok; } catch (e) { resultOk = false; }
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (resultSeen && resultOk) return resolve(true);
      reject(new Error('Gagal menyiapkan model ' + modelId + ' (kode ' + code + ')'));
    });
    try {
      child.stdin.write(JSON.stringify({
        modelsDir: _modelsDir || '',
        modelId,
        language: '',
        chunks: []
      }));
      child.stdin.end();
    } catch (e) { reject(e); }
  });
}

function transcribeSmallViaChild(chunkPaths, onChunkDone, o) {
  return new Promise((resolve) => {
    const child = spawnASRChild(o.registerChild);

    const words = [];
    const doneIdx = new Set();
    let buf = '';
    let resultSeen = false;
    let resultOk = false;
    let cancelledKill = false;
    const origKill = child.kill.bind(child);
    child.kill = (sig) => { cancelledKill = true; return origKill(sig || 'SIGKILL'); };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const ln of lines) {
        if (ln.startsWith(ASR_MARK_CHUNK)) {
          try {
            const msg = JSON.parse(ln.slice(ASR_MARK_CHUNK.length));
            if (!doneIdx.has(msg.i)) {
              doneIdx.add(msg.i);
              words.push(...(msg.words || []));
              if (onChunkDone) onChunkDone(doneIdx.size, chunkPaths.length);
            }
          } catch (e) {}
        } else if (ln.startsWith(ASR_MARK_RESULT)) {
          resultSeen = true;
          try { resultOk = !!JSON.parse(ln.slice(ASR_MARK_RESULT.length)).ok; } catch (e) { resultOk = false; }
        } else if (ln.startsWith(ASR_MARK_PROG)) {
          try { if (o.onProgress) o.onProgress(JSON.parse(ln.slice(ASR_MARK_PROG.length))); } catch (e) {}
        }
      }
    });

    const finish = async (fallbackOk) => {
      // Susun ulang urutan kata
      words.sort((a, b) => a.start - b.start);
      const remaining = chunkPaths
        .filter((x) => !doneIdx.has(x.idx));
      const failed = !resultSeen || !resultOk; // child mati (OOM) atau lapor gagal
      if (failed && remaining.length && fallbackOk && !cancelledKill) {
        // Child mati sebelum selesai (mis. kehabisan RAM) -> fallback ke model hemat RAM
        try {
          const fbWords = await transcribeInProcess(remaining, onChunkDone, {
            modelId: o.fallbackModel || 'Xenova/whisper-base',
            language: o.language,
            doneOffset: doneIdx.size,
            totalCount: chunkPaths.length
          });
          words.push(...fbWords);
        } catch (e) { /* pakai apa yang sudah ada */ }
      }
      words.sort((a, b) => a.start - b.start);
      resolve(words);
    };

    child.on('error', () => finish(true));
    child.on('close', () => finish(true));

    try {
      child.stdin.write(JSON.stringify({
        modelsDir: _modelsDir || '',
        modelId: o.modelId,
        language: o.language,
        chunks: chunkPaths.map((x) => x.path || x)
      }));
      child.stdin.end();
    } catch (e) {
      child.kill('SIGKILL');
    }
  });
}

async function transcribeWavChunks(chunkPaths, onChunkDone, opts = {}) {
  const modelId = opts.modelId || MODEL_IDS.asr;
  const lang = opts.language || 'indonesian'; // 'indonesian' | 'english' | 'auto'
  const entries = chunkPaths.map((p, i) => ({ path: p, idx: i }));
  // whisper-small: proses terpisah (aman dari OOM, aplikasi utama tetap responsif)
  if (/small/i.test(modelId) && opts.inProcess !== true) {
    return transcribeSmallViaChild(entries, onChunkDone, {
      modelId, language: lang, registerChild: opts.registerChild,
      onProgress: opts.onProgress,
      fallbackModel: opts.fallbackModel || 'Xenova/whisper-base'
    });
  }
  return transcribeInProcess(entries, onChunkDone, {
    modelId, language: lang, doneOffset: 0, totalCount: entries.length
  });
}

/*
 * entries: [{path, idx}] - idx = posisi asli chunk (1 chunk = 60 detik)
 * dipakai untuk offset timestamp: idx * 60
 */
async function transcribeInProcess(entries, onChunkDone, o = {}) {
  const modelId = o.modelId || MODEL_IDS.asr;
  const lang = o.language || 'indonesian';
  const passLang = lang && lang !== 'auto';
  const cpus = (os.cpus() || []).length || 2;
  const N = Math.max(1, Math.min(4, Math.max(1, cpus - 1), entries.length));
  const totalCount = o.totalCount || entries.length;
  const doneOffset = o.doneOffset || 0;

  // 1) Decode semua audio + deteksi bagian yang ada suaranya
  const audios = [];
  const speech = [];
  for (const ent of entries) {
    let s = null;
    try { s = loadWavAsFloat32(ent.path); } catch (e) { s = null; }
    audios.push(s);
    speech.push(s ? chunkHasSpeech(s) : false);
  }

  // 2) Siapkan pool pipeline (berurutan supaya download model tidak dobel)
  const pipes = [];
  for (let i = 0; i < N; i++) pipes.push(await ensureASR(modelId));

  // 3) Worker paralel mengantre chunk
  const words = [];
  let cursor = 0;
  let done = 0;
  const transcribeOne = async (pipe, audio, offset) => {
    let out = null;
    const baseOpts = {
      return_timestamps: true, // level segmen -> tanpa DTW kata (jauh lebih cepat)
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      no_repeat_ngram_size: 6 // cegah halusinasi berulang (mempercepat + subtitle lebih bersih)
    };
    if (passLang) baseOpts.language = lang; // 'auto' -> whisper deteksi sendiri per potongan
    try {
      out = await pipe(audio, baseOpts);
    } catch (e1) {
      try {
        out = await pipe(audio, {
          return_timestamps: true,
          chunk_length_s: 30,
          stride_length_s: 5,
          task: 'transcribe'
        });
      } catch (e2) { out = null; }
    }
    return out && out.chunks ? segmentsToWords(out.chunks, offset) : [];
  };

  const worker = async (wi) => {
    const pipe = pipes[wi];
    while (true) {
      const i = cursor++;
      if (i >= entries.length) break;
      let w = [];
      if (audios[i] && speech[i]) {
        w = await transcribeOne(pipe, audios[i], entries[i].idx * 60);
      }
      words.push(...w);
      done++;
      if (onChunkDone) onChunkDone(doneOffset + done, totalCount);
    }
  };
  await Promise.all(Array.from({ length: N }, (_, wi) => worker(wi)));

  words.sort((a, b) => a.start - b.start);
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

/* ================================================================
 * SISTEM KLIP PASTI SESUAI JUMLAH (v1.5.0)
 * Masalah lama: LLM kecil (Qwen 0.5B) sering mengembalikan hanya 1-2
 * momen sehingga hasilnya cuma 1 klip walau user minta 5.
 * Solusi: BAGI video menjadi N jendela waktu sama panjang, lalu ambil
 * TEPAT SATU momen terbaik dari TIAP jendela. Dijamin jumlah klip =
 * jumlah yang dipilih user, semuanya berbeda & tidak tumpang tindih.
 * ================================================================ */
const MIN_CLIP_SEC = 5;

function titleFromText(text, maxWords = 6) {
  const w = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
  return w || 'Klip Viral';
}

/*
 * Bagi rentang analisis menjadi N jendela sama panjang.
 * Kalau video terlalu pendek untuk N x target, durasi klip otomatis
 * disesuaikan agar N klip tetap muat tanpa tumpang tindih.
 */
function planWindows(usableDur, count, targetSec) {
  const n = Math.max(1, Math.min(30, Math.floor(count) || 1));
  let target = Math.max(MIN_CLIP_SEC, Math.floor(targetSec) || 30);
  let note = null;
  if (usableDur > 0 && usableDur < n * target) {
    const shrunk = Math.floor(usableDur / n);
    if (shrunk >= MIN_CLIP_SEC && shrunk < target) {
      note = `Video lebih pendek dari ${n} x ${target} dtk. Durasi tiap klip otomatis disesuaikan jadi ${shrunk} dtk agar ${n} klip tetap terbuat semua.`;
      target = shrunk;
    }
  }
  const winLen = usableDur / n;
  const windows = [];
  for (let i = 0; i < n; i++) {
    windows.push({ ws: i * winLen, we: (i + 1) * winLen });
  }
  return { windows, target, note };
}

/* Pilih momen skor tertinggi di dalam satu jendela waktu */
function pickInWindow(segments, ws, we, target, videoDuration) {
  const cands = segments
    .filter((s) => s.end > ws && s.start < we)
    .map((s) => ({ s, score: scoreSegment(s) + (s.end - s.start >= 3 ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  const lead = Math.min(3, target * 0.15);
  for (const c of cands) {
    let start = Math.max(ws, c.s.start - lead);
    let end = start + target;
    if (end > we && we - start >= MIN_CLIP_SEC) end = we; // tetap di dalam jendela
    if (end > videoDuration) end = videoDuration;
    if (end - start < MIN_CLIP_SEC) continue;
    return { start: Math.floor(start), end: Math.floor(end), title: titleFromText(c.s.text) };
  }
  return null;
}

/* Jendela tanpa transkrip -> ambil bagian tengah jendela */
function centerMoment(ws, we, target, videoDuration) {
  const len = we - ws;
  let start = ws + Math.max(0, (len - target) / 2);
  let end = start + target;
  if (end > videoDuration) end = videoDuration;
  if (end - start < MIN_CLIP_SEC) {
    end = Math.min(videoDuration, we);
    start = Math.max(ws, end - Math.max(MIN_CLIP_SEC, Math.min(target, end)));
  }
  if (end - start < MIN_CLIP_SEC) return null;
  return { start: Math.floor(start), end: Math.floor(end), title: 'Klip Viral' };
}

/* Validasi + kunci momen hasil LLM agar berada di dalam jendelanya */
function clampToWindow(cand, w, target, videoDuration) {
  if (!cand || typeof cand !== 'object') return null;
  let start = Math.max(0, Number(cand.start) || 0);
  let end = Number(cand.end) || 0;
  if (!isFinite(end) || end <= start) end = start + target;
  const mid = (start + end) / 2;
  if (mid < w.ws || mid > w.we) return null; // LLM menjawab di luar jendela -> abaikan
  let dur = end - start;
  if (dur > target * 1.9) dur = target;
  if (dur < MIN_CLIP_SEC) dur = target;
  let s = Math.min(Math.max(start, w.ws), Math.max(w.ws, w.we - dur));
  let e = Math.min(s + dur, w.we);
  if (e - s < MIN_CLIP_SEC) return null;
  if (e > videoDuration) { e = videoDuration; if (e - s < MIN_CLIP_SEC) return null; }
  const title = String(cand.title || '').trim().slice(0, 60);
  return { start: Math.floor(s), end: Math.floor(e), title: title || null };
}

function buildLLMPrompt(segments, windows, target) {
  const lines = [];
  let total = 0;
  const LIMIT = 1400; // jaga RAM tetap aman di PC 8GB
  for (const s of segments) {
    const line = `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`;
    if (total + line.length > LIMIT) break;
    lines.push(line);
    total += line.length;
  }
  const winLines = windows
    .map((w, i) => `${i + 1}. ${Math.floor(w.ws)}s sampai ${Math.floor(w.we)}s`)
    .join('\n');
  const sys = 'You are a viral video editor AI. Reply with ONLY a valid JSON array. No explanation.';
  const usr =
    `This video transcript is divided into exactly ${windows.length} time windows. ` +
    `For EACH window, pick the single most viral, attention-grabbing moment inside that window (a clip of about ${target} seconds). ` +
    `Reply ONLY with a JSON array with EXACTLY ${windows.length} items, one item per window, in window order, like: [{"start":12,"end":42,"title":"short catchy title"}] . ` +
    `The "title" must be in the same language as the transcript, max 6 words.\n\n` +
    `Windows:\n${winLines}\n\n` +
    `Transcript with timestamps (seconds):\n` + lines.join('\n');
  return (
    `<|im_start|>system\n${sys}<|im_end|>\n` +
    `<|im_start|>user\n${usr}<|im_end|>\n` +
    `<|im_start|>assistant\n[{"start":`
  );
}

/*
 * Analisis utama: hasil PASTI sebanyak maxClips (selama video cukup panjang).
 * Urutan: momen LLM per jendela -> heuristik per jendela -> tengah jendela.
 * opts.runLLM boleh diinjeksi untuk pengujian (prompt, maxNewTokens) -> {text}|null
 */
async function analyzeMoments(segments, videoDuration, targetSec, maxClips, onLog, opts = {}) {
  if (!segments.length) return [];
  const plan = planWindows(videoDuration, maxClips, targetSec);
  if (plan.note && onLog) onLog(plan.note);

  let parsed = null;
  try {
    if (onLog) onLog('AI sedang menganalisis transkrip (lokal, tanpa internet)...');
    const prompt = buildLLMPrompt(segments, plan.windows, plan.target);
    const maxNew = Math.min(800, 110 + 45 * plan.windows.length);
    const res = opts.runLLM
      ? await opts.runLLM(prompt, maxNew)
      : await runLLMInChild(prompt, maxNew, opts);
    if (res && res.text) {
      parsed = extractJsonArray('[{"start":' + res.text) || extractJsonArray(res.text);
    }
    if (parsed && parsed.length && onLog) {
      onLog(`AI lokal mengusulkan ${parsed.length} momen (dikunci per jendela waktu).`);
    }
  } catch (err) {
    if (onLog) onLog('AI lokal tidak tersedia (' + String(err && err.message || err).slice(0, 60) + '), memakai analisis heuristik...');
  }

  // Satu momen per jendela -> jumlah klip selalu sesuai pilihan user
  const picked = [];
  for (let i = 0; i < plan.windows.length; i++) {
    const w = plan.windows[i];
    const cand = Array.isArray(parsed) ? parsed[i] : null;
    let m = clampToWindow(cand, w, plan.target, videoDuration);
    if (!m) m = pickInWindow(segments, w.ws, w.we, plan.target, videoDuration);
    if (!m) m = centerMoment(w.ws, w.we, plan.target, videoDuration);
    if (m) picked.push(m);
  }

  // Rapikan: urutkan & pastikan tidak ada tumpang tindih
  picked.sort((a, b) => a.start - b.start);
  const out = [];
  for (const m of picked) {
    let { start, end, title } = m;
    const prev = out[out.length - 1];
    if (prev && start < prev.end) start = prev.end;
    if (end <= start) end = Math.min(videoDuration, start + plan.target);
    if (end > videoDuration) end = videoDuration;
    if (end - start < MIN_CLIP_SEC) continue;
    out.push({ start: Math.floor(start), end: Math.floor(end), title: String(title || 'Klip Viral').slice(0, 60) });
  }
  if (onLog) onLog(`${out.length} momen viral dipilih (satu terbaik dari tiap jendela waktu).`);
  return out;
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

module.exports = {
  init,
  ensureASR,
  ensureASRReady,
  ensureLLM,
  loadTransformers,
  runLLMInChild,
  transcribeWavChunks,
  wordsToSegments,
  analyzeMoments,
  heuristicMoments,
  clampMoments,
  planWindows,
  pickInWindow,
  extractJsonArray,
  loadWavAsFloat32,
  MODEL_IDS
};
