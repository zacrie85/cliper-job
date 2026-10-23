/* Screenshot UI untuk verifikasi visual v1.6.0 + cek error console */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1220, height: 940, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true }
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 2) errors.push(msg + ' @' + src + ':' + line);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => errors.push('FAIL-LOAD: ' + desc));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  require('fs').mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });
  require('fs').writeFileSync('/tmp/ui-v16.png', img.toPNG());
  // Verifikasi elemen baru v1.6.0 ada di DOM
  const checks = await win.webContents.executeJavaScript(`({
    faceTrack: !!document.getElementById('chk-face'),
    subSize: document.querySelectorAll('#seg-subsize button').length,
    subOutline: document.querySelectorAll('#seg-suboutline button').length,
    musicSrc: document.querySelectorAll('#seg-musicsrc button').length,
    musicTag: document.getElementById('sel-musictag') ? document.getElementById('sel-musictag').options.length : 0,
    duck: !!document.getElementById('chk-duck'),
    modelObj: !!document.getElementById('status-obj'),
    stages: (typeof STAGES !== 'undefined') ? STAGES.length : window.__stages || -1
  })`);
  console.log('CHECKS:', JSON.stringify(checks));
  console.log('JS_ERRORS:', errors.length ? errors.join(' | ') : 'none');
  console.log('SCREENSHOT_OK');
  app.quit();
}).catch((e) => { console.error('FATAL', e); process.exit(1); });
