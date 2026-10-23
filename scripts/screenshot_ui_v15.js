/* Screenshot UI untuk verifikasi visual v1.5.0 + cek error console */
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
  require('fs').writeFileSync(path.join(__dirname, '..', 'tmp', 'ui-v15.png'), img.toPNG());
  // Verifikasi elemen baru ada di DOM
  const checks = await win.webContents.executeJavaScript(`({
    color: !!document.getElementById('inp-color'),
    swatches: document.querySelectorAll('.swatch').length,
    font: document.getElementById('sel-font') ? document.getElementById('sel-font').options.length : 0,
    effect: !!document.getElementById('seg-effect'),
    effectBtns: document.querySelectorAll('#seg-effect button').length
  })`);
  console.log('CHECKS:', JSON.stringify(checks));
  console.log('JS_ERRORS:', errors.length ? errors.join(' | ') : 'none');
  console.log('SCREENSHOT_OK');
  app.quit();
});
