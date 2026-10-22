/* Probe memori whisper-small: transkrip audio pendek + laporan RSS per tahap */
const path = require('path');
const fs = require('fs');

async function main() {
  const ROOT = path.join(__dirname, '..');
  const ai = require(path.join(ROOT, 'lib', 'ai'));
  const { env } = await ai.loadTransformers();
  const rss = (label) => {
    const m = process.memoryUsage();
    console.log(`    [MEM] ${label}: rss=${(m.rss / 1e6).toFixed(0)}MB heap=${(m.heapUsed / 1e6).toFixed(0)}MB`);
  };
  await ai.init(path.join(ROOT, 'tmp', 'models-test-v14'), {});
  rss('awal');
  const pipe = await ai.ensureASR('Xenova/whisper-small', () => {});
  rss('model dimuat');
  const wavefile = require('wavefile');
  const wav = new wavefile.WaveFile(fs.readFileSync(path.join(ROOT, 'tmp', 'audio-test-8s.wav')));
  wav.toBitDepth('32f'); wav.toSampleRate(16000);
  let samples = wav.getSamples(); if (Array.isArray(samples)) samples = samples[0];
  rss('audio siap');
  const t0 = Date.now();
  const out = await pipe(samples, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', language: 'indonesian', no_repeat_ngram_size: 6 });
  rss('selesai transkrip');
  console.log(`    waktu: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('    TEKS: ' + (out.text || '').slice(0, 200));
}
main().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
