/* Screenshot UI untuk verifikasi visual v1.4.0 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1220, height: 880, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(__dirname, '..', 'tmp', 'ui-v14.png'), img.toPNG());
  console.log('SCREENSHOT_OK');
  app.quit();
});
