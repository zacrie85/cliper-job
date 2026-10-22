/* Isolasi memori ONNX whisper-small: encoder saja vs decoder saja */
const path = require('path');
const fs = require('fs');

const MODEL_DIR = path.join(__dirname, '..', 'tmp', 'models-test-v14', 'Xenova', 'whisper-small', 'onnx');
const RSS = (l) => console.log(`    [MEM] ${l}: rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);

async function runSession(file, feeds, label, sessOpts) {
  const ort = require('onnxruntime-node');
  RSS(`${label} - sebelum create`);
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, file), sessOpts);
  RSS(`${label} - sesudah create`);
  const t0 = Date.now();
  await session.run(feeds);
  console.log(`    ${label} - run selesai dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  RSS(`${label} - sesudah run`);
}

async function main() {
  const ort = require('onnxruntime-node');
  const mode = process.argv[2] || 'encoder';
  const arenaOff = process.argv[3] !== 'arena';
  const opts = arenaOff
    ? { executionProviders: ['cpu'], enableCpuMemArena: false, intra_op_num_threads: 2, graphOptimizationLevel: 'all' }
    : { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
  console.log(`MODE=${mode} arenaOff=${arenaOff}`);

  if (mode === 'encoder' || mode === 'both') {
    const feats = new ort.Tensor('float32', new Float32Array(1 * 80 * 3000), [1, 80, 3000]);
    await runSession('encoder_model_quantized.onnx', { input_features: feats }, 'ENCODER', opts);
  }
  if (mode === 'decoder' || mode === 'both') {
    // Langkah decoder pertama: ids [1,1] + past kosong utk tiap layer
    const cfg = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, '..', 'config.json'), 'utf8'));
    const L = cfg.n_layer || 12, H = cfg.n_head || 12, D = (cfg.d_model || 768) / H;
    const ids = new ort.Tensor('int64', BigInt64Array.from([BigInt(50258)]), [1, 1]);
    const feeds = { input_ids: ids, encoder_hidden_states: new ort.Tensor('float32', new Float32Array(1 * 1500 * 768), [1, 1500, 768]), use_cache_branch: new ort.Tensor('bool', new Uint8Array([0]), [1]) };
    for (let i = 0; i < L; i++) {
      feeds[`past_key_values.${i}.decoder.key`] = new ort.Tensor('float32', new Float32Array(1 * H * 0 * D), [1, H, 0, D]);
      feeds[`past_key_values.${i}.decoder.value`] = new ort.Tensor('float32', new Float32Array(1 * H * 0 * D), [1, H, 0, D]);
      feeds[`past_key_values.${i}.encoder.key`] = new ort.Tensor('float32', new Float32Array(1 * H * 1500 * D), [1, H, 1500, D]);
      feeds[`past_key_values.${i}.encoder.value`] = new ort.Tensor('float32', new Float32Array(1 * H * 1500 * D), [1, H, 1500, D]);
    }
    await runSession('decoder_model_merged_quantized.onnx', feeds, 'DECODER-1step', opts);
  }
  console.log('    [SELESAI]');
}

main().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
