#!/bin/bash
# Re-download Windows binaries + fonts untuk build CLIPER JOB
set -e
cd "$(dirname "$0")/../cheat-clip-pro-offline"
mkdir -p resources/bin resources/fonts tmp

echo "[1/3] yt-dlp.exe ..."
if [ ! -f resources/bin/yt-dlp.exe ]; then
  curl -sL -o resources/bin/yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
fi
ls -la resources/bin/yt-dlp.exe

echo "[2/3] ffmpeg/ffprobe win64 BtbN ..."
if [ ! -f resources/bin/ffmpeg.exe ]; then
  curl -sL -o tmp/ffmpeg-win64.zip https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip
  cd tmp && python3 -c "
import zipfile, shutil, os
z = zipfile.ZipFile('ffmpeg-win64.zip')
for n in z.namelist():
    if n.endswith('/bin/ffmpeg.exe') or n.endswith('/bin/ffprobe.exe'):
        z.extract(n, '.')
        shutil.move(n, '../resources/bin/' + os.path.basename(n))
" && cd ..
fi
ls -la resources/bin/

echo "[3/3] Font Poppins ..."
cd resources/fonts
for w in Regular SemiBold Bold ExtraBold; do
  if [ ! -f "Poppins-$w.ttf" ]; then
    curl -sL -o "Poppins-$w.ttf" "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-$w.ttf"
  fi
done
ls -la
echo "SELESAI"
