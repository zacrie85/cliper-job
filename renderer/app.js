/* CLIPER JOB - Renderer logic */
const $ = (id) => document.getElementById(id);

const state = {
  sourceType: 'url', // 'url' | 'file'
  filePath: null,
  watermarkPath: null,
  musicPath: null,
  outputDir: '',
  running: false,
  clips: []
};

const STAGES = [
  { id: 'download', label: 'Mengunduh video' },
  { id: 'audio', label: 'Mengekstrak audio' },
  { id: 'transcribe', label: 'Transkripsi AI (offline)' },
  { id: 'analyze', label: 'Analisis momen viral (offline)' },
  { id: 'detect', label: 'Face tracking — kunci pembicara (offline)' },
  { id: 'render', label: 'Merender klip (paralel)' }
];

/* ---------- Init ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  wireSegments();
  wireButtons();
  wireSwatches();
  wireDragDrop();
  const info = await window.api.appInfo();
  state.outputDir = info.outputDir;
  $('inp-output').value = info.outputDir;
  $('badge-version').textContent = 'v' + info.version;
  refreshModels();
  window.api.on(handleEvent);
});

/* ---------- Drag & drop video/audio/gambar ke jendela ---------- */
function wireDragDrop() {
  const extVideo = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'vob', 'ogv'];
  const extAudio = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma'];
  const extImage = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
  const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  document.addEventListener('dragover', prevent);
  document.addEventListener('dragenter', prevent);
  document.addEventListener('drop', (e) => {
    prevent();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    for (const f of files) {
      const ext = extOf(f.name);
      if (extVideo.includes(ext)) { setVideoFile(f.path, f.size); return; }
    }
    for (const f of files) {
      const ext = extOf(f.name);
      if (extAudio.includes(ext)) {
        state.musicPath = f.path;
        document.querySelector('#seg-musicsrc button[data-v="custom"]').click();
        setStatus('Musik latar ditambahkan dari file yang di-drop.');
        return;
      }
    }
    for (const f of files) {
      const ext = extOf(f.name);
      if (extImage.includes(ext)) {
        state.watermarkPath = f.path;
        $('chk-wm').checked = true;
        $('wm-hint').textContent = 'Watermark: ' + f.path;
        setStatus('Watermark diatur dari gambar yang di-drop.');
        return;
      }
    }
    setStatus('Format file tidak dikenali. Gunakan video (mp4/mkv/webm/mov/avi...), audio, atau gambar.');
  });
}

/* ---------- Segmented controls ---------- */
function wireSegments() {
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  const segVal = (id) => document.querySelector('#' + id + ' button.active').dataset.v;
  window._segVal = segVal;

  // Tampilkan input manual saat pilihan "Kustom" dipilih
  $('seg-duration').addEventListener('click', () => {
    const v = segVal('seg-duration');
    $('row-duration-custom').style.display = v === 'custom' ? 'flex' : 'none';
    if (v === 'custom') $('inp-duration').focus();
  });
  $('seg-count').addEventListener('click', () => {
    const v = segVal('seg-count');
    $('row-count-custom').style.display = v === 'custom' ? 'flex' : 'none';
    if (v === 'custom') $('inp-count').focus();
  });
  // Sumber musik (v1.6.0)
  $('seg-musicsrc').addEventListener('click', () => {
    const v = segVal('seg-musicsrc');
    $('music-builtin-row').style.display = v === 'builtin' ? 'block' : 'none';
    $('music-custom-row').style.display = v === 'custom' ? 'flex' : 'none';
    const on = v !== 'none';
    $('music-vol-row').style.display = on ? 'flex' : 'none';
    $('music-duck-row').style.display = on ? 'flex' : 'none';
    if (v === 'builtin') $('music-hint').textContent = 'Musik dari pustaka aplikasi — otomatis di-loop & fade.';
    else if (v === 'custom') $('music-hint').textContent = state.musicPath ? 'Musik: ' + state.musicPath : 'Belum pilih file musik.';
    else $('music-hint').textContent = '';
  });
}

/* ---------- Swatch warna subtitle ---------- */
function wireSwatches() {
  document.querySelectorAll('.swatch').forEach((b) => {
    b.addEventListener('click', () => {
      $('inp-color').value = b.dataset.c;
    });
  });
}

/* ---------- Buttons ---------- */
async function setVideoFile(p, sizeBytes) {
  try {
    const st = await window.api.statFile(p);
    if (!st || !st.exists || !st.isFile) {
      setStatus('File tidak ditemukan: ' + p);
      return;
    }
    state.sourceType = 'file';
    state.filePath = p;
    const size = sizeBytes || st.size || 0;
    $('picked-file-hint').textContent = 'File video siap: ' + p + ' (' + fmtSize(size) + ')';
    $('inp-url').value = '';
    setStatus('Video siap diproses! Klik BUAT KLIP SEKARANG.');
  } catch (err) {
    setStatus('Gagal memuat file: ' + String(err && err.message || err));
  }
}

function wireButtons() {
  $('btn-pick-video').addEventListener('click', async () => {
    try {
      setStatus('Membuka dialog pilih file...');
      const p = await window.api.pickFile('video');
      if (p) await setVideoFile(p);
      else setStatus('Pilih file dibatalkan, atau tempel URL video di kolom atas.');
    } catch (err) {
      setStatus('Gagal membuka dialog file: ' + String(err && err.message || err));
    }
  });
  $('inp-url').addEventListener('input', () => {
    state.sourceType = 'url';
    state.filePath = null;
    $('picked-file-hint').textContent = '';
  });
  $('btn-pick-output').addEventListener('click', async () => {
    const p = await window.api.pickFolder();
    if (p) {
      state.outputDir = p;
      $('inp-output').value = p;
    }
  });
  $('btn-pick-wm').addEventListener('click', async () => {
    const p = await window.api.pickFile('image');
    if (p) {
      state.watermarkPath = p;
      $('chk-wm').checked = true;
      $('wm-hint').textContent = 'Watermark: ' + p;
    }
  });
  $('btn-pick-music').addEventListener('click', async () => {
    const p = await window.api.pickFile('audio');
    if (p) {
      state.musicPath = p;
      $('music-hint').textContent = 'Musik: ' + p;
    }
  });
  $('rng-music').addEventListener('input', (e) => {
    $('music-vol-val').textContent = e.target.value + '%';
  });
  $('btn-download-models').addEventListener('click', downloadModels);
  $('btn-start').addEventListener('click', startJob);
  $('btn-cancel').addEventListener('click', () => window.api.cancelJob());
  $('btn-open-folder').addEventListener('click', () => window.api.openPath(state.outputDir));
}

/* ---------- Models ---------- */
async function refreshModels() {
  const s = await window.api.modelsStatus();
  setModelUI('asr', s.asr);
  setModelUI('small', s.small);
  setModelUI('llm', s.llm);
  setModelUI('obj', s.obj);
}

function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function setModelUI(key, info) {
  const el = $('status-' + key);
  const bar = $('bar-' + key);
  if (info && info.downloaded) {
    el.textContent = 'Siap (' + fmtSize(info.size) + ') - offline';
    el.classList.add('ok');
    bar.style.width = '100%';
  } else {
    el.textContent = 'Belum terunduh';
    el.classList.remove('ok');
    bar.style.width = '0%';
  }
}

let downloading = false;
async function downloadModels() {
  if (downloading) return;
  downloading = true;
  const btn = $('btn-download-models');
  btn.disabled = true;
  btn.textContent = 'Mengunduh model AI... jangan tutup aplikasi';
  setStatus('Mengunduh model AI (sekali saja)...');
  const r = await window.api.modelsDownload();
  downloading = false;
  btn.disabled = false;
  btn.textContent = 'Download Model AI (sekali saja)';
  if (r.ok) {
    setModelUI('asr', r.asr);
    setModelUI('small', r.small);
    setModelUI('llm', r.llm);
    setModelUI('obj', r.obj);
    setStatus('Model AI siap! Aplikasi kini 100% offline.');
    appendLog('Semua model AI siap dipakai offline.');
  } else {
    setStatus('Gagal download model: ' + r.error);
    appendLog('ERROR: ' + r.error);
  }
}

/* ---------- Job ---------- */
function buildCfg() {
  const durSel = window._segVal('seg-duration');
  const cntSel = window._segVal('seg-count');
  return {
    sourceType: state.sourceType,
    url: ($('inp-url').value || '').trim(),
    filePath: state.filePath,
    outputDir: state.outputDir,
    clipDuration: durSel === 'custom' ? parseInt($('inp-duration').value, 10) : parseInt(durSel, 10),
    clipCount: cntSel === 'custom' ? parseInt($('inp-count').value, 10) : parseInt(cntSel, 10),
    format: window._segVal('seg-format'),
    subtitleStyle: window._segVal('seg-subtitle'),
    subtitlePosition: window._segVal('seg-position'),
    subtitleSize: window._segVal('seg-subsize'),
    subtitleOutline: window._segVal('seg-suboutline'),
    subtitleColor: ($('inp-color').value || '').trim(),
    subtitleFont: $('sel-font').value,
    faceTrack: $('chk-face').checked,
    cameraMotion: window._segVal('seg-cammotion'),
    captionText: ($('inp-caption').value || '').trim(),
    captionPosition: window._segVal('seg-cappos'),
    cinematicEffect: window._segVal('seg-effect'),
    asrLanguage: window._segVal('seg-lang'),
    watermarkPath: $('chk-wm').checked ? state.watermarkPath : null,
    musicSource: window._segVal('seg-musicsrc'),
    musicTrack: $('sel-musictag').value,
    musicPath: state.musicPath,
    musicVolume: parseInt($('rng-music').value, 10) / 100,
    musicDuck: $('chk-duck').checked,
    hookSfx: $('chk-sfx').checked,
    asrModel: window._segVal('seg-speed') === 'accurate' ? 'Xenova/whisper-small' : 'Xenova/whisper-base',
    maxAnalysisMin: parseInt(window._segVal('seg-analysis'), 10)
  };
}

async function startJob() {
  if (state.running) return;
  const cfg = buildCfg();
  if (cfg.sourceType === 'file' && !cfg.filePath) {
    setStatus('Pilih file video dulu, atau tempel URL video.');
    return;
  }
  if (cfg.sourceType === 'file' && cfg.filePath) {
    const st = await window.api.statFile(cfg.filePath);
    if (!st || !st.exists) {
      setStatus('File video tidak ditemukan, pilih ulang filenya.');
      return;
    }
  }
  if (cfg.sourceType === 'url' && !cfg.url) {
    setStatus('Tempel URL video dulu atau pilih file video.');
    return;
  }
  if (cfg.sourceType === 'url' && !/^https?:\/\//i.test(cfg.url)) {
    setStatus('URL tidak valid. Harus dimulai dengan http/https.');
    return;
  }
  if (!Number.isFinite(cfg.clipDuration) || cfg.clipDuration < 10 || cfg.clipDuration > 1800) {
    setStatus('Durasi klip kustom harus diisi antara 10 sampai 1800 detik.');
    return;
  }
  if (!Number.isFinite(cfg.clipCount) || cfg.clipCount < 1 || cfg.clipCount > 30) {
    setStatus('Jumlah klip kustom harus diisi antara 1 sampai 30.');
    return;
  }
  state.running = true;
  state.clips = [];
  $('btn-start').disabled = true;
  $('btn-cancel').style.display = 'block';
  $('card-results').style.display = 'none';
  $('card-progress').style.display = 'block';
  renderStages();
  clearLog();
  setStatus('Proses dimulai...');
  await window.api.startJob(cfg);
}

function renderStages() {
  const wrap = $('stage-list');
  wrap.innerHTML = '';
  for (const st of STAGES) {
    const row = document.createElement('div');
    row.className = 'stage';
    row.id = 'stage-' + st.id;
    row.innerHTML = `<span class="dot"></span><span>${st.label}</span>
      <div class="stage-bar"><div class="stage-bar-fill" id="bar-stage-${st.id}"></div></div>`;
    wrap.appendChild(row);
  }
}

function setStage(stage, status) {
  const row = $('stage-' + stage);
  if (!row) return;
  row.classList.remove('active', 'done');
  if (status === 'active') row.classList.add('active');
  if (status === 'done') row.classList.add('done');
  if (status === 'pending') {
    const bar = $('bar-stage-' + stage);
    if (bar) bar.style.width = '0%';
  }
}

function handleEvent(data) {
  switch (data.type) {
    case 'stage':
      setStage(data.stage, data.status);
      if (data.status === 'active') setStatus(data.label + '...');
      break;
    case 'progress': {
      const bar = $('bar-stage-' + data.stage);
      if (bar) bar.style.width = data.pct.toFixed(1) + '%';
      break;
    }
    case 'log':
      appendLog(data.message);
      break;
    case 'model-progress': {
      if (data.status === 'progress' && data.total) {
        const pct = (data.loaded / data.total) * 100;
        const validKeys = ['llm', 'small', 'asr', 'tiny', 'obj'];
        const key = validKeys.includes(data.model) ? data.model : 'asr';
        const bar = $('bar-' + key);
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        $('status-' + key).textContent =
          'Mengunduh ' + (data.file || '') + ' ' + pct.toFixed(0) + '% (' + fmtSize(data.loaded) + ' / ' + fmtSize(data.total) + ')';
      }
      break;
    }
    case 'moments':
      for (const m of data.moments || []) {
        appendLog('Momen dipilih: ' + Math.floor(m.start / 60) + ':' + String(Math.floor(m.start % 60)).padStart(2, '0') + ' - ' + m.title);
      }
      break;
    case 'job-done':
      state.clips = data.clips || [];
      showResults();
      finishJob('SELESAI! ' + state.clips.length + ' klip berhasil dibuat.');
      break;
    case 'job-error':
      finishJob('GAGAL: ' + data.message, true);
      break;
    case 'models-ready':
      refreshModels();
      break;
  }
}

function showResults() {
  const card = $('card-results');
  const list = $('clip-list');
  card.style.display = 'block';
  list.innerHTML = '';
  for (const c of state.clips) {
    const row = document.createElement('div');
    row.className = 'clip-item';
    row.innerHTML = `<div><div class="clip-name"></div><div class="clip-size">${c.sizeText}</div></div>`;
    row.querySelector('.clip-name').textContent = c.name;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-show';
    btn.textContent = 'Tampilkan';
    btn.addEventListener('click', () => window.api.showItem(c.file));
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function finishJob(msg, isError) {
  state.running = false;
  $('btn-start').disabled = false;
  $('btn-cancel').style.display = 'none';
  setStatus(msg);
  appendLog(msg);
}

/* ---------- Log & status ---------- */
function appendLog(msg) {
  const el = $('log');
  if (!el) return;
  const t = new Date().toLocaleTimeString('id-ID');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">[${t}]</span> `;
  line.appendChild(document.createTextNode(msg));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { const el = $('log'); if (el) el.innerHTML = ''; }
function setStatus(s) { const el = $('status-text'); if (el) el.textContent = s; }
