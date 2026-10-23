# CLIPER JOB

**AI Auto Clipper 100% OFFLINE untuk Windows** — ubah video YouTube / Google Drive / video lokal menjadi klip viral TikTok / Shorts / Reels dengan subtitle karaoke animasi, tanpa API key, tanpa langganan, tanpa mengirim data ke cloud.

> Terinspirasi dari [galihjuansaputra/cheat-clip-pro](https://github.com/galihjuansaputra/cheat-clip-pro). Seluruh kode ditulis ulang dari nol sebagai aplikasi desktop offline (Electron), bukan fork.

---

## Perbedaan dengan Versi Asli

| | Cheat Clip Pro (asli) | CLIPER JOB (ini) |
|---|---|---|
| AI | Google Gemini API (online, perlu API key) | **Whisper + Qwen 1.5 lokal** (offline) |
| Koneksi internet | Wajib saat dipakai | Hanya untuk download video & sekali download model AI |
| Biaya AI | Kuota API / API key | **Gratis selamanya** |
| Privasi | Transkrip terkirim ke cloud | **Semua diproses di PC sendiri** |
| Bentuk | Web app (React + Python + Docker) | **Installer .exe untuk Windows** |
| Face tracking | Ya (Python) | **FACE TRACKING v1.6.0 (YOLOS AI)** — crop 9:16 otomatis mengikuti pembicara |

## Download & Instalasi

1. Buka halaman [**Releases**](../../releases) dan download `CLIPER-JOB-Setup-1.3.0.exe`
2. Jalankan installer. Jika muncul peringatan **Windows SmartScreen** (karena aplikasi tidak ditandatangani secara digital):
   - Klik **More info** → **Run anyway**
3. Selesai! Aplikasi terpasang dengan shortcut di desktop.

### Download Model AI (SEKALI SAJA)

Saat pertama kali dibuka, klik tombol **"Download Model AI"** di aplikasi:

| Model | Fungsi | Ukuran |
|---|---|---|
| Whisper Base (ONNX) | Suara → teks + timestamp per kata | ± 80 MB |
| YOLOS-tiny (ONNX) | Face tracking: deteksi orang & kunci pembicara | ± 27 MB |
| Qwen 1.5 0.5B Chat (ONNX) | Analisis & pilih momen paling viral | ± 490 MB |

Setelah terunduh (tersimpan di `%APPDATA%\cliper-job\models`), aplikasi **tidak butuh internet lagi selamanya** — transkripsi dan analisis 100% di PC kamu.

## Cara Pakai

1. **Tempel URL** video (YouTube, Google Drive, dll) **atau pilih file video** dari komputer
2. Atur pengaturan:
   - Durasi klip: 15 / 30 / 60 detik
   - Jumlah klip: 2–5
   - Format frame: 9:16 Penuh / 9:16 Blur / 1:1 Kotak / 16:9 Asli
   - Gaya subtitle: **Pop Viral** (kata membesar satu per satu) / **Karaoke** (warna jalan per kata) / tanpa subtitle
   - Watermark logo, musik latar + volume, efek suara hook (opsional)
3. Klik **BUAT KLIP SEKARANG** → aplikasi otomatis:
   - Mengunduh video (yt-dlp)
   - Mengekstrak audio → **Whisper** menulis transkrip dengan timestamp per kata (offline)
   - **Qwen** menganalisis transkrip dan memilih momen paling viral (offline)
   - **FFmpeg** memotong & merender setiap klip dengan subtitle animasi
4. Klik **Buka Folder Output** — klip siap di-upload!

## Spesifikasi yang Disarankan

- Windows 10 / 11 (64-bit)
- RAM **8 GB** (4 GB masih bisa jalan; jika RAM penuh, analisis AI otomatis beralih ke mode heuristik)
- Ruang disk: ± 2 GB (aplikasi + model AI + file video)
- CPU apa saja (Intel/AMD); GPU tidak wajib

## Troubleshooting

**Installer diblokir SmartScreen** → Normal untuk aplikasi tanpa sertifikat digital. Klik More info → Run anyway.

**Antivirus mendeteksi yt-dlp.exe** → False positive yang umum pada yt-dlp. Tambahkan folder instalasi ke pengecualian antivirus jika yakin aman.

**Download model AI gagal** → Periksa koneksi internet sekali saja untuk tahap ini. Model terunduh dari HuggingFace (huggingface.co).

**Video YouTube gagal diunduh** → Versi yt-dlp yang dibundel bisa kedaluwarsa karena YouTube sering berubah. Download `yt-dlp.exe` terbaru dari [github.com/yt-dlp/yt-dlp/releases](https://github.com/yt-dlp/yt-dlp/releases) lalu timpa file di folder instalasi (folder `resources\bin`).

**Klip hasil kurang relevan** → Perbesar "Analisis AI maksimal (menit)" agar AI membaca lebih banyak transkrip.

## Teknologi

- **Electron 31** (desktop shell) + vanilla JS renderer
- **Transformers.js (ONNX Runtime)** — Whisper-base & Qwen1.5-0.5B-Chat berjalan lokal via CPU
- **FFmpeg** (build BtbN GPL) — potong, crop, subtitle ASS (libass), mixing audio
- **yt-dlp** — unduh video dari YouTube/Drive/ratusan situs lain
- **electron-builder NSIS** — installer Windows

## Struktur Kode

```
main.js              Proses utama Electron (IPC, window, path)
preload.js           Jembatan aman renderer <-> main
lib/ai.js            Engine AI lokal (Whisper + wrapper LLM child-process)
lib/llm_worker.js    Worker LLM terisolasi (tahan OOM)
lib/video.js         yt-dlp, ffprobe, ffmpeg render pipeline
lib/subs.js          Generator subtitle ASS (Pop Viral / Karaoke)
lib/job.js           Orkestrasi pipeline utama
renderer/            UI (HTML/CSS/JS)
resources/bin/       ffmpeg.exe, ffprobe.exe, yt-dlp.exe
resources/fonts/     Poppins (subtitle)
```

## Build dari Source (Opsional)

```bash
# 1. Download binary (yt-dlp, ffmpeg, font) — ±250MB
bash scripts/fetch-binaries.sh

# 2. Install dependencies
npm install

# 3. Build installer Windows (.exe)
#    Di Linux dipakai NODE_OPTIONS patch agar tidak butuh wine:
NODE_OPTIONS="--require ./scripts/patch-macos-check.js" npx electron-builder --win nsis --x64
#    Di Windows cukup: npm run dist
```

Hasil build ada di folder `release/`.

## Disclaimer

Gunakan hanya untuk video **milik sendiri** atau video yang **memiliki izin** untuk diunduh dan diproses. Mengunduh video milik orang lain dapat melanggar ketentuan layanan platform terkait. Proyek ini tidak berafiliasi dengan TikTok, YouTube, atau Google.

## Lisensi

MIT — lihat [LICENSE](LICENSE).

## Riwayat Versi

### v1.6.0 — Face Tracking + Style Subtitle + BGM + Lebih Cepat
- **🎯 FACE TRACKING (crop ikut pembicara)** — fitur yang paling diminta! Kini crop 9:16 otomatis MENGIKUTI orang yang sedang bicara (model AI YOLOS-tiny lokal ± 27 MB). Cocok untuk podcast 2+ orang: saat pembicara berganti, crop panning mulus ke dia. Ada toggle on/off; fallback aman ke crop tengah bila tak ada orang terdeteksi.
- **📝 Subtitle lebih banyak style** — ukuran (Kecil/Normal/Besar) + outline (Tipis/Normal/Tebal/Kotak Hitam semi-transparan), digabung 10 font & warna bebas.
- **🎵 Musik latar (BGM)** — pustaka 4 musik bawaan aplikasi (Lo-Fi Chill, Upbeat Pop, Cinematic, Soft Ambient — royalty-free) atau file sendiri; **auto-duck**: musik mengecil otomatis saat ada yang bicara; loop + fade in/out otomatis.
- **⚡ Lebih cepat** — render klip kini PARALEL (2 klip sekaligus); face tracking sangat cepat (optimasi resolusi deteksi 16x lebih cepat, hasil malah lebih akurat).

### v1.3.0 — Fix render + transkripsi jauh lebih cepat
- **FIX: "Unrecognized option filter_complex_script"** pada proses Merender Klip — ffmpeg baru (8+) menghapus opsi lama itu; kini filter graph dikirim langsung sebagai argumen (didukung semua versi ffmpeg) dengan fallback otomatis untuk ffmpeg lama
- **Transkripsi AI jauh lebih cepat:**
  - Pilihan baru "Kecepatan transkripsi AI": **Cepat** (Whisper Tiny, default) / **Akurat** (Whisper Base)
  - **Paralel**: beberapa bagian audio diproses bersamaan sesuai jumlah core CPU
  - **Bagian sunyi/hening di-skip** tanpa diproses AI (video banyak jeda/sunyi bisa puluhan kali lebih cepat)
  - Timestamp level segmen (tanpa DTW per kata yang berat) + pembagian kata proporsional untuk subtitle karaoke
  - Anti-halusinasi berulang (`no_repeat_ngram_size`) — subtitle lebih bersih & tidak memakan waktu
  - Benchmark suara asli: **3.5x lebih cepat** dengan 1 worker; di PC 4-8 core total bisa **7-15x** (plus skip sunyi)
- Panel Model AI kini menampilkan 3 model: Whisper Tiny, Whisper Base, Qwen

### v1.2.0 — Perbaikan total loader AI
- **FIX: "Cannot find package '@huggingface/jinja'"** — semua dependency library AI (jinja, onnxruntime-node/web, sharp) kini diikutkan secara utuh ke dalam installer; arsip asar dimatikan sepenuhnya agar resolusi modul Node 100% standar, tanpa kejutan
- Binary sharp Windows (`@img/sharp-win32-x64`) ikut ter-pack, plus binding native onnxruntime win32 terverifikasi
- Seluruh jalur diuji dari pohon file ter-pack: import transformers.js, transkripsi Whisper, dan worker LLM — semua lulus

### v1.1.0 — CLIPER JOB
- **Aplikasi berganti nama menjadi CLIPER JOB** (sebelumnya Cheat Clip Pro Offline)
- **Perbaikan penting:** gagal download model AI (`require() of ES Module ... not supported`) — library AI kini dimuat lewat dynamic `import()` ESM dan berjalan di semua kondisi
- **Perbaikan:** import file video kini lebih andal — format didukung diperluas (wmv, flv, mpg, ts, 3gp, dll) + tombol "Semua File", validasi file, dan pesan kesalahan yang jelas
- **Fitur baru:** drag & drop file video/musik/watermark langsung ke jendela aplikasi

### v1.0.0 — Cheat Clip Pro Offline
- Rilis perdana: AI Auto Clipper 100% offline (Whisper + Qwen lokal, FFmpeg, yt-dlp)
