/*
 * lib/subs.js - Generator subtitle ASS gaya viral (Pop & Karaoke)
 * v1.5.0: 10 font pilihan populer TikTok/YouTube Shorts + warna subtitle kustom
 */
const fs = require('fs');
const path = require('path');

function ts(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(Math.min(cs, 99))}`;
}

function assColor(rgb, alpha = 0) {
  // rgb: '#RRGGBB' -> ASS &HAABBGGRR
  const r = parseInt(rgb.slice(1, 3), 16);
  const g = parseInt(rgb.slice(3, 5), 16);
  const b = parseInt(rgb.slice(5, 7), 16);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  const rr = r.toString(16).padStart(2, '0').toUpperCase();
  const gg = g.toString(16).padStart(2, '0').toUpperCase();
  const bb = b.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${bb}${gg}${rr}`;
}

function escText(t) {
  return String(t)
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

const ACCENT = '#FFD400';   // kuning viral (pemantik/hook)
const WHITE = '#FFFFFF';
const OUTLINE = '#1A1A1A';

/* ================================================================
 * KATALOG FONT (v1.5.0) - 10 font paling populer untuk konten
 * TikTok & YouTube Shorts. Semua file TTF ikut ter-pack di
 * resources/fonts dan disalin ke folder render (fontsdir=.)
 * family  : nama internal font (harus persis, dipakai libass)
 * file    : nama file TTF di resources/fonts
 * bold    : 1 bila perlu flag bold (font punya banyak weight)
 * size    : ukuran dasar di PlayRes 1080 (font sempit perlu lebih besar)
 * ================================================================ */
const FONTS = {
  poppins:    { family: 'Poppins ExtraBold', file: 'Poppins-ExtraBold.ttf',   bold: 0, size: 72 },
  montserrat: { family: 'Montserrat',        file: 'Montserrat-Bold.ttf',     bold: 1, size: 72 },
  bebas:      { family: 'Bebas Neue',        file: 'BebasNeue-Regular.ttf',   bold: 0, size: 88 },
  anton:      { family: 'Anton',             file: 'Anton-Regular.ttf',       bold: 0, size: 76 },
  archivo:    { family: 'Archivo Black',     file: 'ArchivoBlack-Regular.ttf',bold: 0, size: 70 },
  barlow:     { family: 'Barlow Condensed',  file: 'BarlowCondensed-Bold.ttf',bold: 1, size: 88 },
  luckiest:   { family: 'Luckiest Guy',      file: 'LuckiestGuy-Regular.ttf', bold: 0, size: 70 },
  bangers:    { family: 'Bangers',           file: 'Bangers-Regular.ttf',     bold: 0, size: 86 },
  titan:      { family: 'Titan One',         file: 'TitanOne-Regular.ttf',    bold: 0, size: 72 },
  lilita:     { family: 'Lilita One',        file: 'LilitaOne-Regular.ttf',   bold: 0, size: 74 }
};

function fontDef(key) {
  return FONTS[key] || FONTS.poppins;
}

/* ---------- util warna ---------- */
function safeColor(c, fallback) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) return c.trim().toUpperCase();
  return fallback;
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* Warna kekuningan (mirip ACCENT) -> hook diganti putih agar tetap kontras */
function isYellowish(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r > 180 && g > 140 && b < 110;
}

/*
 * Tentukan pasangan warna: primer (teks utama) & hook (kata penting).
 * color kosong -> gaya lama: putih + kuning.
 * Teks gelap -> outline putih agar tetap terbaca.
 */
function paletteFor(color) {
  const primary = safeColor(color, WHITE);
  const hook = isYellowish(primary) ? WHITE : ACCENT;
  const outline = luminance(primary) < 0.32 ? WHITE : OUTLINE;
  return { primary, hook, outline };
}

/*
 * Posisi subtitle (alignment ASS gaya numpad):
 *  - top    -> \an8 (atas tengah)
 *  - center -> \an5 (pas di tengah)
 *  - bottom -> \an2 (bawah tengah)
 */
function alignFor(position) {
  if (position === 'top') return 8;
  if (position === 'bottom') return 2;
  return 5;
}

/* Jarak aman dari tepi atas/bawah supaya tidak tertutup UI TikTok/Reels */
function marginVFor(position, playResY) {
  if (position === 'center') return 0;
  return Math.round(playResY * 0.055);
}

function header(playResX, playResY, position, color, fontKey) {
  const align = alignFor(position);
  const mv = marginVFor(position, playResY);
  const f = fontDef(fontKey);
  const { primary, hook, outline } = paletteFor(color);
  const size1 = f.size;
  const size2 = Math.round(f.size * 0.89);
  return `[Script Info]
Title: CLIPER JOB
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop,${f.family},${size1},${assColor(primary)},${assColor(hook)},${assColor(outline)},&H00000000,${f.bold},0,0,0,100,100,1,0,1,5,2,${align},60,60,${mv},1
Style: Karaoke,${f.family},${size2},${assColor(primary)},${assColor(WHITE)},${assColor(outline)},&H00000000,${f.bold},0,0,0,100,100,1,0,1,5,2,${align},60,60,${mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function playResFor(fmt) {
  if (fmt === 'square') return { x: 1080, y: 1080 };
  if (fmt === 'original') return { x: 1280, y: 720 };
  return { x: 1080, y: 1920 };
}

/* ---------- Gaya POP: satu kata per waktu, memantul ---------- */
function popEvents(words, clipStart, clipEnd, position, color) {
  const an = alignFor(position);
  const { hook } = paletteFor(color);
  const events = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end <= clipStart || w.start >= clipEnd) continue;
    const next = words[i + 1];
    let s = Math.max(w.start, clipStart) - clipStart;
    let e = Math.min(next ? next.start : w.end, clipEnd) - clipStart;
    if (e <= s) e = s + 0.35;
    if (e - s > 1.2) e = s + 1.2;
    const text = escText(w.text);
    if (!text) continue;
    const isHook = /\d|\?|!/.test(text) || text.length > 6;
    const colorTag = isHook ? '{\\c' + assColor(hook) + '}' : '';
    events.push(
      `Dialogue: 0,${ts(s)},${ts(e)},Pop,,0,0,0,,{\\an${an}\\fad(50,50)\\t(0,90,\\fscx118\\fscy118)\\t(90,200,\\fscx100\\fscy100)}${colorTag}${text}`
    );
  }
  return events;
}

/* ---------- Gaya KARAOKE: baris dengan \k per kata ---------- */
function karaokeEvents(words, clipStart, clipEnd, position) {
  const an = alignFor(position);
  const events = [];
  let line = [];
  const flush = () => {
    if (!line.length) return;
    const ls = line[0].w.start - clipStart;
    const le = Math.min(line[line.length - 1].w.end, clipEnd) - clipStart;
    if (le > ls + 0.2) {
      const body = line.map((it) => {
        let d = Math.max(1, Math.round((it.w.end - it.w.start) * 100));
        if (it.last) d = Math.max(1, Math.round((Math.min(it.w.end, clipEnd) - it.w.start) * 100));
        return `{\\k${d}}${escText(it.w.text)}`;
      }).join(' ');
      events.push(`Dialogue: 0,${ts(Math.max(0, ls))},${ts(le)},Karaoke,,0,0,0,,{\\an${an}\\fad(60,60)}${body}`);
    }
    line = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end <= clipStart || w.start >= clipEnd) continue;
    if (line.length) {
      const prev = line[line.length - 1].w;
      const gap = w.start - prev.end;
      const span = w.end - line[0].w.start;
      if (gap > 0.6 || span > 2.4 || line.length >= 5) flush();
    }
    line.push({ w, last: i === words.length - 1 });
  }
  flush();
  return events;
}

/*
 * words: [{text,start,end}] absolut terhadap video sumber
 * opts: { fmt, style: 'pop'|'karaoke'|'none', clipStart, clipEnd,
 *         position: 'top'|'center'|'bottom',
 *         color: '#RRGGBB' (warna subtitle pilihan user),
 *         font: kunci font FONTS (poppins/montserrat/bebas/...) }
 * return { assPath, dir } atau null jika style none / tanpa kata
 */
function writeAss(words, tmpDir, opts) {
  const { fmt, style, clipStart, clipEnd, position, color, font } = opts;
  if (style === 'none' || !words || !words.length) return null;
  const res = playResFor(fmt);
  let events;
  if (style === 'karaoke') events = karaokeEvents(words, clipStart, clipEnd, position);
  else events = popEvents(words, clipStart, clipEnd, position, color);
  if (!events.length) return null;
  const content = header(res.x, res.y, position, color, font) + events.join('\n') + '\n';
  fs.mkdirSync(tmpDir, { recursive: true });
  const assPath = path.join(tmpDir, 'subs.ass');
  fs.writeFileSync(assPath, content, 'utf8');
  return assPath;
}

module.exports = { writeAss, ts, assColor, FONTS, fontDef, paletteFor };
