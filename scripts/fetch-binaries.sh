#!/bin/bash
# fetch-binaries.sh — Download binary Windows + font sebelum build.
# Jalankan dari root proyek: bash scripts/fetch-binaries.sh
set -e
cd "$(dirname "$0")/.."

mkdir -p resources/bin resources/fonts tmp assets

echo "[1/3] yt-dlp.exe..."
[ -f resources/bin/yt-dlp.exe ] || curl -sL -o resources/bin/yt-dlp.exe "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

echo "[2/3] FFmpeg Win64 (BtbN GPL)..."
if [ ! -f resources/bin/ffmpeg.exe ]; then
  curl -sL -o tmp/ffmpeg-win64.zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  unzip -o -j tmp/ffmpeg-win64.zip "*/bin/ffmpeg.exe" "*/bin/ffprobe.exe" -d resources/bin/
  rm -f tmp/ffmpeg-win64.zip
fi

echo "[3/3] Font Poppins..."
[ -f resources/fonts/Poppins-ExtraBold.ttf ] || curl -sL -o resources/fonts/Poppins-ExtraBold.ttf "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-ExtraBold.ttf"
[ -f resources/fonts/Poppins-Bold.ttf ] || curl -sL -o resources/fonts/Poppins-Bold.ttf "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf"

echo "Selesai! Binary siap di resources/."
