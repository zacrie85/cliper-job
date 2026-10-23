#!/bin/bash
# Re-download Windows binaries + fonts untuk build CLIPER JOB
set -e
cd "$(dirname "$0")/.."
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

echo "[3/3] Font subtitle (10 font populer) ..."
cd resources/fonts
declare -A FONTS=(
  ["Poppins-ExtraBold"]="ofl/poppins/Poppins-ExtraBold.ttf"
  ["Montserrat-Bold"]="https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf"
  ["BebasNeue-Regular"]="ofl/bebasneue/BebasNeue-Regular.ttf"
  ["Anton-Regular"]="ofl/anton/Anton-Regular.ttf"
  ["ArchivoBlack-Regular"]="ofl/archivoblack/ArchivoBlack-Regular.ttf"
  ["BarlowCondensed-Bold"]="ofl/barlowcondensed/BarlowCondensed-Bold.ttf"
  ["LuckiestGuy-Regular"]="apache/luckiestguy/LuckiestGuy-Regular.ttf"
  ["Bangers-Regular"]="ofl/bangers/Bangers-Regular.ttf"
  ["TitanOne-Regular"]="ofl/titanone/TitanOne-Regular.ttf"
  ["LilitaOne-Regular"]="ofl/lilitaone/LilitaOne-Regular.ttf"
)
for f in "${!FONTS[@]}"; do
  if [ ! -f "$f.ttf" ]; then
    echo "  - $f.ttf"
    v="${FONTS[$f]}"
    case "$v" in
      http*) curl -sL -o "$f.ttf" "$v" ;;
      *) curl -sL -o "$f.ttf" "https://github.com/google/fonts/raw/main/$v" ;;
    esac
  fi
done
ls -la
echo "SELESAI"
