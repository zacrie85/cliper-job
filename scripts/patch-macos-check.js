/*
 * patch-macos-check.js — dipakai via NODE_OPTIONS="--require ./scripts/patch-macos-check.js"
 * Memaksa electron-builder memakai jalur UninstallerReader (JS murni) alih-alih
 * wine saat membuat uninstaller NSIS di Linux. Jalur ini normalnya hanya
 * dipakai di macOS Catalina+ yang tidak punya wine.
 */
const path = require('path');
try {
  const m = require(path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'util', 'macosVersion'));
  if (m && typeof m.isMacOsCatalina === 'function') {
    m.isMacOsCatalina = function () { return true; };
    console.log('[patch] isMacOsCatalina -> true (pakai UninstallerReader, tanpa wine)');
  }
} catch (e) {
  console.warn('[patch] gagal:', e.message);
}
