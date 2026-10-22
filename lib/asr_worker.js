/*
 * lib/asr_worker.js - Worker CHILD PROCESS untuk transkripsi Whisper model besar (whisper-small).
 * Dipakai agar model akurat berjalan terisolasi: kalau RAM tidak cukup (OOM),
 * proses utama aplikasi tetap hidup dan bisa fallback otomatis ke model cepat.
 *
 * Protokol:
 *   stdin  : JSON { modelsDir, modelId, language, chunks: [wavPath,...] }
 *   stdout : per chunk -> "###CCP_CHUNK###" + JSON {i, words:[{text,start,end}]}
 *            selesai   -> "###CCP_RESULT###" + JSON {ok:true, total:n}
 *            fatal     -> "###CCP_RESULT###" + JSON {ok:false, error:"..."}
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARK_CHUNK = '###CCP_CHUNK###';
const MARK_RESULT = '###CCP_RESULT###';

function send(mark, obj) {
  process.stdout.write(mark + JSON.stringify(obj) + '\n');
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const d of process.stdin) input += d;

  const cfg = JSON.parse(input);
  const ROOT = path.join(__dirname, '..');

  // Muat transformers.js dari file disk yang sama seperti proses utama
  const rel = path.join('node_modules', '@xenova', 'transformers', 'src', 'transformers.js');
  const tfFile = process.env.CCP_TF_FILE || path.join(ROOT, rel);
  const tfMod = await import(require('url').pathToFileURL(tfFile).href);
  try {
    const ort = require('onnxruntime-node');
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
  } catch (e) { /* abaikan */ }

  const { env, pipeline } = tfMod;
  env.cacheDir = cfg.modelsDir;
  env.localModelPath = cfg.modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  const progCb = (p) => {
    try {
      if (p && p.status === 'progress' && p.total) {
        send('###CCP_PROG###', { status: 'progress', file: p.file, loaded: p.loaded, total: p.total, model: /small/i.test(cfg.modelId) ? 'small' : (/tiny/i.test(cfg.modelId) ? 'tiny' : 'asr') });
      }
    } catch (e) { /* abaikan */ }
  };
  const pipe = await pipeline('automatic-speech-recognition', cfg.modelId, { quantized: true, progress_callback: progCb });

  // helper: decode wav -> Float32 (sama seperti lib/ai.js)
  function loadWavAsFloat32(wavPath) {
    const wavefile = require('wavefile');
    const wav = new wavefile.WaveFile(fs.readFileSync(wavPath));
    wav.toBitDepth('32f');
    wav.toSampleRate(16000);
    let samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
    return samples;
  }
  function chunkHasSpeech(samples) {
    try {
      const win = 16000;
      let speechWin = 0;
      for (let i = 0; i + 8000 <= samples.length; i += win) {
        let sum = 0;
        const end = i + win;
        for (let j = i; j < end; j++) sum += samples[j] * samples[j];
        if (Math.sqrt(sum / win) > 0.0045) speechWin++;
        if (speechWin >= 2) return true;
      }
      return speechWin >= 2;
    } catch (e) { return true; }
  }
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

  const passLang = cfg.language && cfg.language !== 'auto';
  let total = 0;
  for (let i = 0; i < cfg.chunks.length; i++) {
    const p = cfg.chunks[i];
    let out = null;
    let words = [];
    try {
      const audio = loadWavAsFloat32(p);
      if (audio && chunkHasSpeech(audio)) {
        const opts = {
          return_timestamps: true,
          chunk_length_s: 30,
          stride_length_s: 5,
          task: 'transcribe',
          no_repeat_ngram_size: 6
        };
        if (passLang) opts.language = cfg.language;
        try {
          out = await pipe(audio, opts);
        } catch (e1) {
          try {
            out = await pipe(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' });
          } catch (e2) { out = null; }
        }
        if (out && out.chunks) words = segmentsToWords(out.chunks, i * 60);
      }
    } catch (eChunk) {
      // chunk tunggal gagal -> lewati, lanjut chunk berikutnya
      words = [];
    }
    total++;
    send(MARK_CHUNK, { i, words });
    // beri kesempatan pipe ter-flush
    await new Promise((r) => setImmediate(r));
  }
  send(MARK_RESULT, { ok: true, total });
  process.exit(0);
}

main().catch((e) => {
  try {
    send(MARK_RESULT, { ok: false, error: String(e && e.message || e).slice(0, 300) });
  } catch (e2) {}
  process.exit(1);
});
