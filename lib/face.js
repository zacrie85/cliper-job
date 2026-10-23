/*
 * lib/face.js - FACE TRACKING v1.6.0 (100% offline)
 *
 * Tujuan: crop 9:16 otomatis MENGIKUTI pembicara (bukan center statis).
 * Contoh kasus: video podcast 2 orang duduk bersebelahan — saat pembicara
 * kiri bicara, crop pindah ke kiri; saat yang kanan bicara, pindah lagi.
 *
 * Cara kerja:
 *  1. Ekstrak frame sampel dari segmen klip (3 fps, resolusi kecil — cepat)
 *  2. Deteksi ORANG di tiap frame memakai YOLOS-tiny ONNX (@xenova/transformers,
 *     model ± 27 MB, didownload sekali lalu offline selamanya)
 *  3. Orang dilacak antar frame memakai IoU (bukan index — urutan box dari
 *     detektor bisa berubah-ubah). "Pembicara aktif" dipilih lewat skor GERAK
 *     (orang bicara = kepala/badan bergerak) + ukuran + histeresis supaya
 *     crop tidak goyang bolak-balik.
 *  4. Lintasan dihaluskan (EMA) -> daftar titik {t, cx} siap dipakai
 *     ffmpeg crop x-expression.
 *
 * Fallback aman: bila model belum ada / gagal / tak ada orang terdeteksi,
 * mengembalikan Map kosong -> pipeline memakai crop center seperti versi lama.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FPS = 3;              // frame per detik untuk analisis
const DET_W = 384;          // lebar frame deteksi
const MOT_W = 96;           // lebar frame grayscale utk skor gerak
const SCORE_MIN = 0.62;     // ambang deteksi person (buang false positive lemah)
const EMA_ALPHA = 0.20;     // kehalusan lintasan
const SWITCH_MARGIN = 1.25; // histeresis: skor lawan harus 25% lebih tinggi
const SWITCH_HOLD = 2;      // frame berturut-turut menang sebelum crop pindah
const ABSENT_HOLD_SEC = 2;  // orang hilang < 2 dtk -> posisi ditahan
const PERSIST_BONUS = 0.14; // bonus target aktif (anti goyang ke objek statis)
const MIN_H_FRAC = 0.14;    // box person wajib tingginya >= 14% tinggi frame
const MIN_AREA_FRAC = 0.015; // dan luasnya >= 1.5% frame
const AR_MIN = 0.35;        // rasio w/h masuk akal utk manusia
const AR_MAX = 1.6;
const MAX_STEP = 70;        // batas lompatan pusat per frame (px koord deteksi) — anti flicker

let _detector = null;

async function ensureDetector(modelsDir, onProgress) {
  if (_detector) return _detector;
  const ai = require('./ai');
  _detector = await ai.ensureObjDetector((p) => { if (onProgress) onProgress(p); });
  return _detector;
}

/* ---------- Ekstrak frame JPEG kecil utk deteksi ---------- */
function extractDetectFrames(ffmpeg, sourceFile, start, dur, tmpDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const args = [
      '-y', '-nostdin',
      '-ss', String(start), '-t', String(Math.max(1, dur)),
      '-i', sourceFile,
      '-vf', `fps=${FPS},scale=${DET_W}:-2`,
      '-q:v', '4',
      path.join(tmpDir, 'd%04d.jpg')
    ];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg frame gagal: ' + stderr.slice(-240)));
      const frames = fs.readdirSync(tmpDir).filter((f) => /^d\d+\.jpg$/.test(f)).sort();
      resolve(frames.map((f) => path.join(tmpDir, f)));
    });
  });
}

/* ---------- Ekstrak frame grayscale mentah utk skor gerak ---------- */
function extractMotionFrames(ffmpeg, sourceFile, start, dur, tmpDir) {
  return new Promise((resolve, reject) => {
    const out = path.join(tmpDir, 'motion.raw');
    const args = [
      '-y', '-nostdin',
      '-ss', String(start), '-t', String(Math.max(1, dur)),
      '-i', sourceFile,
      '-vf', `fps=${FPS},scale=${MOT_W}:-2,format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      out
    ];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg motion gagal: ' + stderr.slice(-240)));
      try {
        const buf = fs.readFileSync(out);
        resolve(buf); // dipotong per-frame belakangan (butuh tinggi frame)
      } catch (e) { reject(e); }
    });
  });
}

/* ---------- IoU antar dua box {x,y,w,h} ---------- */
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/* ---------- Skor gabungan: gerak + ukuran + kedekatan tengah ---------- */
function boxScore(box, prevGray, gray, motW, motH, detW, detH) {
  let mo = 0;
  if (prevGray && gray) {
    const fx = motW / detW, fy = motH / detH;
    const x0 = Math.max(0, Math.floor(box.x * fx));
    const x1 = Math.min(motW, Math.ceil((box.x + box.w) * fx));
    const y0 = Math.max(0, Math.floor(box.y * fy));
    const y1 = Math.min(motH, Math.ceil((box.y + box.h) * fy));
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y += 2) {
      const row = y * motW;
      for (let x = x0; x < x1; x += 2) {
        const i = row + x;
        sum += Math.abs(gray[i] - prevGray[i]);
        n++;
      }
    }
    mo = n ? sum / n : 0;
  }
  const size = Math.sqrt((box.w * box.h) / (detW * detH)); // 0..1
  const centerDist = Math.abs((box.x + box.w / 2) - detW / 2) / (detW / 2);
  return mo * 0.05 + size * 0.85 - centerDist * 0.22;
}

/* ---------- Deteksi person pada 1 frame JPEG ---------- */
async function detectPersons(detector, imagePath, detW, detH) {
  const out = await detector(imagePath, { threshold: SCORE_MIN, percentage: false });
  const list = [];
  for (const r of out || []) {
    if (!r || r.label !== 'person') continue;
    const b = r.box || {};
    const x1 = b.xmin, y1 = b.ymin, x2 = b.xmax, y2 = b.ymax;
    if (![x1, y1, x2, y2].every((v) => typeof v === 'number' && isFinite(v))) continue;
    const w = x2 - x1, h = y2 - y1;
    if (w < 12 || h < 12) continue;
    // Sanity filter (v1.6.0): buang "person" palsu — terlalu kecil, terlalu
    // pipih (tanaman/objek), atau rasio tidak masuk akal utk manusia.
    if (h < detH * MIN_H_FRAC) continue;
    if (w * h < detW * detH * MIN_AREA_FRAC) continue;
    const ar = w / h;
    if (ar < AR_MIN || ar > AR_MAX) continue;
    // Lipasan gorden/tepi layar: box SEMPIT yang menjulur sampai tepi bawah
    // frame (y2 >= 97% tinggi) — hampir selalu false positive statis.
    const touchesBottom = (y1 + h) >= detH * 0.97;
    if (touchesBottom && ar < 0.45) continue;
    if (touchesBottom && h > detH * 0.72 && w < detW * 0.16) continue;
    list.push({ x: x1, y: y1, w, h, score: r.score || 0 });
  }
  return list;
}

/* ---------- v1.7.0: mode SNAP — cut langsung antar pembicara ----------
 * centers[] (koordinat deteksi) dikelompokkan menjadi segmen posisi stabil.
 * Crop BERHENTI TOTAL di satu posisi, lalu LANGSUNG pindah (cut, tanpa pan)
 * saat pembicara berganti: perubahan pusat > 35% lebar crop yang bertahan
 * >= 1 detik dianggap ganti pembicara. Hasil: titik step [{t, cx}] konstan
 * di tiap segmen (median cx segmen = posisi crop yang stabil). */
function snapPoints(centers, dt, scaleX, cropWDet) {
  const THRESH = cropWDet * 0.35;
  const HOLD = Math.max(2, Math.round(1.0 / dt)); // ~1 detik @ 3fps
  const segs = [];
  let anchor = centers[0].cx;
  let segStart = 0;
  let pending = null;
  for (let i = 1; i < centers.length; i++) {
    const cx = centers[i].cx;
    if (Math.abs(cx - anchor) > THRESH) {
      if (!pending) pending = { idx: i, count: 1 };
      else pending.count++;
      if (pending.count >= HOLD) {
        segs.push({ from: segStart, to: pending.idx - 1 });
        segStart = pending.idx;
        anchor = centers[segStart].cx;
        pending = null;
      }
    } else if (pending) {
      pending = null; // kembali ke posisi lama sebelum hold terpenuhi → batal
    }
  }
  segs.push({ from: segStart, to: centers.length - 1 });
  const pts = segs.map((s) => {
    const xs = centers.slice(s.from, s.to + 1).map((c) => c.cx).sort((a, b) => a - b);
    const med = xs[Math.floor(xs.length / 2)];
    return { t: s.from * dt, cx: med * scaleX };
  });
  return pts;
}

/* ---------- Bangun lintasan utk 1 segmen klip ----------
 * meta: { width, height } resolusi video sumber
 * opts.mode: 'snap' (cut langsung, default v1.7.0) | 'smooth' (pan halus)
 * opts.fmt: 'full916' | 'square' (untuk hitung lebar crop)
 * return { ok, points:[{t,cx,cy}], snap } atau { ok:false, note } */
async function buildTrackForSegment(ffmpeg, sourceFile, start, dur, workDir, detector, meta, opts = {}) {
  const mode = opts.mode === 'smooth' ? 'smooth' : 'snap';
  const frames = await extractDetectFrames(ffmpeg, sourceFile, start, dur, workDir);
  if (!frames.length) return { ok: false, note: 'frame kosong' };

  const vw = meta.width || 1920, vh = meta.height || 1080;
  const detH = Math.round(DET_W * vh / vw / 2) * 2;   // tinggi frame deteksi (scale 384:-2)
  const motH = Math.round(MOT_W * vh / vw / 2) * 2;   // tinggi frame gerak (scale 96:-2)
  const scaleX = vw / DET_W;

  let motionBuf = null;
  try { motionBuf = await extractMotionFrames(ffmpeg, sourceFile, start, dur, workDir); } catch (e) { motionBuf = null; }
  const motFrameLen = MOT_W * motH;
  const motionFrames = [];
  if (motionBuf && motionBuf.length >= motFrameLen) {
    for (let off = 0; off + motFrameLen <= motionBuf.length; off += motFrameLen) {
      motionFrames.push(motionBuf.subarray(off, off + motFrameLen));
    }
  }

  // --- deteksi per frame ---
  const perFrame = [];
  for (const f of frames) {
    let boxes = [];
    try { boxes = await detectPersons(detector, f, DET_W, detH); } catch (e) { boxes = []; }
    perFrame.push(boxes);
  }

  // --- pelacakan + pemilihan pembicara aktif ---
  const dt = 1 / FPS;
  const maxAbsent = Math.round(ABSENT_HOLD_SEC * FPS);
  let target = null;         // box target saat ini (koord frame kecil)
  let absentRun = 0;
  let switchRun = 0;
  let prevGray = null;
  const centers = [];

  for (let i = 0; i < perFrame.length; i++) {
    const boxes = perFrame[i];
    const gray = motionFrames[i] || null;

    if (!boxes.length) {
      absentRun++;
      if (absentRun > maxAbsent) target = null;
      if (target) centers.push({ t: i * dt, cx: target.x + target.w / 2, cy: target.y + target.h / 2 });
    } else if (!target) {
      let best = null, bestScore = -Infinity;
      for (const b of boxes) {
        const s = boxScore(b, prevGray, gray, MOT_W, motH, DET_W, detH);
        if (s > bestScore) { bestScore = s; best = b; }
      }
      target = { x: best.x, y: best.y, w: best.w, h: best.h };
      absentRun = 0; switchRun = 0;
      centers.push({ t: i * dt, cx: target.x + target.w / 2, cy: target.y + target.h / 2 });
    } else {
      // cocokkan box dengan target lama (IoU, lalu jarak pusat)
      let match = null, bestIoU = 0.12;
      for (const b of boxes) {
        const v = iou(b, target);
        if (v > bestIoU) { bestIoU = v; match = b; }
      }
      if (!match) {
        // tidak ada IoU cukup -> cocokkan dengan box terdekat (ketat:
        // 0.55x dimensi target — kalau lebih jauh, anggap hilang & tahan posisi)
        const tcx = target.x + target.w / 2, tcy = target.y + target.h / 2;
        let nearest = null, nd = Infinity;
        for (const b of boxes) {
          const d = Math.hypot((b.x + b.w / 2) - tcx, (b.y + b.h / 2) - tcy);
          if (d < nd) { nd = d; nearest = b; }
        }
        if (nearest && nd < Math.max(target.w, target.h) * 0.55) match = nearest;
      }
      if (!match) {
        absentRun++;
        if (absentRun > maxAbsent) target = null;
        if (target) centers.push({ t: i * dt, cx: target.x + target.w / 2, cy: target.y + target.h / 2 });
      } else {
        absentRun = 0;
        // cek kandidat lain lebih aktif (ganti pembicara)
        // target saat ini dapat bonus persistensi supaya crop tidak
        // goyang ke false positive statis (tanaman/objek)
        let bestOther = null, bestOtherScore = -Infinity;
        const matchScore = boxScore(match, prevGray, gray, MOT_W, motH, DET_W, detH) + PERSIST_BONUS;
        for (const b of boxes) {
          if (b === match) continue;
          const s = boxScore(b, prevGray, gray, MOT_W, motH, DET_W, detH);
          if (s > bestOtherScore) { bestOtherScore = s; bestOther = b; }
        }
        if (bestOther && bestOtherScore > matchScore * SWITCH_MARGIN) {
          switchRun++;
          if (switchRun >= SWITCH_HOLD) { match = bestOther; switchRun = 0; }
        } else {
          switchRun = 0;
        }
        target = { x: match.x, y: match.y, w: match.w, h: match.h };
        centers.push({ t: i * dt, cx: target.x + target.w / 2, cy: target.y + target.h / 2 });
      }
    }
    prevGray = gray;
  }

  if (centers.length < 3) return { ok: false, note: 'orang tidak terdeteksi cukup lama' };

  if (mode === 'snap') {
    // CUT LANGSUNG: tanpa anti-flicker step & tanpa EMA — crop konstan per segmen
    const cropWDet = opts.fmt === 'square'
      ? Math.min(DET_W, detH)
      : detH * 9 / 16;
    const pts = snapPoints(centers, dt, scaleX, cropWDet);
    if (!pts.length) return { ok: false, note: 'lintasan kosong' };
    return { ok: true, points: pts, snap: true };
  }

  // --- anti flicker: batasi lompatan pusat per frame (mode halus saja) ---
  for (let i = 1; i < centers.length; i++) {
    const a = centers[i - 1], b = centers[i];
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_STEP) {
      const k = MAX_STEP / dist;
      b.cx = a.cx + dx * k;
      b.cy = a.cy + dy * k;
    }
  }

  // --- EMA smoothing (mode halus) ---
  let emaX = null, emaY = null;
  const pts = centers.map((c) => {
    emaX = emaX == null ? c.cx : emaX + EMA_ALPHA * (c.cx - emaX);
    emaY = emaY == null ? c.cy : emaY + EMA_ALPHA * (c.cy - emaY);
    return { t: c.t, cx: emaX * scaleX, cy: emaY * scaleX };
  });

  return { ok: true, points: pts, snap: false };
}

/*
 * Bangun face tracks untuk semua momen/klip.
 * moments: [{start, end, title}]
 * meta: { width, height }
 * opts.mode: 'snap' | 'smooth';  opts.fmt: 'full916' | 'square'
 * return: Map momentIndex -> { points:[{t,cx}], snap } (hanya yang ok)
 */
async function buildTracks(bins, moments, sourceFile, tmpRoot, modelsDir, opts = {}) {
  const { evt, log, meta, onProgress, mode, fmt } = opts;
  const detector = await ensureDetector(modelsDir, (p) => { if (evt) evt('model-progress', p); });
  const result = new Map();
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const dur = m.end - m.start;
    const workDir = path.join(tmpRoot, 'face_' + (i + 1));
    try {
      const tr = await buildTrackForSegment(bins.ffmpeg, sourceFile, m.start, dur, workDir, detector, meta || {}, { mode, fmt });
      if (tr && tr.ok) {
        result.set(i, tr);
        if (log) log(`Face track klip ${i + 1}: ${tr.points.length} ${tr.snap ? 'potongan (cut langsung)' : 'titik'} — crop mengikuti pembicara.`);
      } else {
        if (log) log(`Face track klip ${i + 1}: ${tr && tr.note ? tr.note : 'tidak ada orang'} -> crop tengah.`);
      }
    } catch (e) {
      if (log) log(`Face track klip ${i + 1} gagal (${String(e && e.message || e).slice(0, 60)}) -> crop tengah.`);
    }
    if (onProgress) onProgress((i + 1) / moments.length);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
  return result;
}

module.exports = { buildTracks, ensureDetector, snapPoints, FPS, SCORE_MIN };
