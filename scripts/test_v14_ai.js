/*
 * Test v1.4.0: whisper-small download + transkripsi ID/EN + language auto
 * Jalankan: node scripts/test_v14_ai.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'tmp', 'models-test-v14');
const AUDIO = path.join(ROOT, 'tmp', 'audio-test-v14-16k.wav');

async function main() {
  const ai = require(path.join(ROOT, 'lib', 'ai'));
  await ai.init(MODELS_DIR, {
    asr: 'Xenova/whisper-base',
    small: 'Xenova/whisper-small',
    llm: 'Xenova/Qwen1.5-0.5B-Chat'
  });
  console.log('[1] Memastikan model whisper-small terunduh & siap...');
  const t0 = Date.now();
  await ai.ensureASR('Xenova/whisper-small', (p) => {
    if (p.status === 'progress' && p.total) {
      const pct = ((p.loaded / p.total) * 100).toFixed(0);
      process.stdout.write(`    download ${p.file} ${pct}% (${(p.loaded / 1e6).toFixed(0)}MB)\r\n`);
    }
  });
  console.log(`[1] Model siap dalam ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Potong audio jadi 1 chunk (42.9s) - tulis ulang sebagai chunk wav
  console.log('[2] Transkripsi dengan whisper-small (bahasa: indonesia)...');
  const t1 = Date.now();
  const words = await ai.transcribeWavChunks([AUDIO], (done, total) => {
    console.log(`    chunk ${done}/${total}`);
  }, { modelId: 'Xenova/whisper-small', language: 'indonesian' });
  const secs = ((Date.now() - t1) / 1000).toFixed(1);
  const text = words.map((w) => w.text).join(' ');
  console.log(`[2] Selesai dalam ${secs}s, ${words.length} kata`);
  console.log('[2] HASIL: ' + text.slice(0, 400));

  // Cek kata kunci ID & EN
  const low = text.toLowerCase();
  const checks = {
    'kata ID "rahasia" atau "viral" atau "konten"': /(rahasia|viral|konten)/.test(low),
    'kata EN "important" atau "views" atau "tiktok"': /(important|views|tiktok)/.test(low),
    'slang "gila" atau "gampang" atau "banget"': /(gila|gampang|banget)/.test(low)
  };
  for (const [k, ok] of Object.entries(checks)) console.log(`    [${ok ? 'PASS' : 'MISS'}] ${k}`);

  // Timing kata utk subtitle karaoke
  console.log('[3] Contoh timing 5 kata pertama:');
  words.slice(0, 5).forEach((w) => console.log(`    ${w.start.toFixed(2)}-${w.end.toFixed(2)} "${w.text}"`));

  console.log('[DONE] semua test AI v1.4.0 selesai');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
