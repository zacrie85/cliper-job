#!/bin/bash
# ============================================================
# ensure-winsharp.sh — Pastikan binary sharp WIN32-x64 ada di
# node_modules SEBELUM build electron-builder.
#
# MASALAH: `npm install` di Linux melewati package yang punya
# field os:[win32] (termasuk @img/sharp-win32-x64 yang WAJIB
# dipakai sharp 0.33.x di Windows). Akibatnya build exe sukses
# tetapi aplikasi gagal load transformers.js saat jalan di
# Windows: "Could not load the sharp module using the
# win32-x64 runtime".
#
# SOLUSI: download tarball langsung dari npm registry lalu
# extract manual ke node_modules (bypass cek os/cpu npm).
# ============================================================
set -e
cd "$(dirname "$0")/.."
mkdir -p tmp/node-cache

fetch_pkg () {
  local name="$1" ver="$2"
  local safe; safe=$(echo "$name" | sed 's#@#_#; s#/#-#g')
  local dest="node_modules/$name"
  local tgz="tmp/node-cache/${safe}-${ver}.tgz"
  if [ -f "$dest/package.json" ]; then
    echo "[OK] $name@$ver sudah ada"
    return 0
  fi
  if [ ! -f "$tgz" ]; then
    echo "[DL] $name@$ver ..."
    curl -sL --retry 3 -o "$tgz" "https://registry.npmjs.org/$name/-/$(basename $name)-${ver}.tgz"
  fi
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest" --strip-components=1
  echo "[FIX] $name@$ver terpasang di $dest"
}

# Binding + DLL libvips untuk Windows x64 (dipakai sharp 0.33.5)
fetch_pkg "@img/sharp-win32-x64" "0.33.5"

# Sanity check: file binding .node & DLL wajib ada
test -f "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node" || { echo "FATAL: lib/sharp-win32-x64.node tidak ada"; exit 1; }
test -f "node_modules/@img/sharp-win32-x64/lib/libvips-42.dll" || { echo "FATAL: lib/libvips-42.dll tidak ada"; exit 1; }
echo "SELESAI: sharp win32-x64 siap untuk build Windows."
