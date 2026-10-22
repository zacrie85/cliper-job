/*
 * Cheat Clip Pro Offline - Main Process
 * AI Auto Clipper 100% offline untuk Windows
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('cheat-clip-pro-offline');

let win = null;
let jobCancelFlag = false;
let activeChildren = [];

const MODELS = {
  asr: 'Xenova/whisper-base',
  llm: 'Xenova/Qwen1.5-0.5B-Chat'
};

function modelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

function sendEvt(type, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('evt', { type, ...payload });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#0b0e17',
    autoHideMenuBar: true,
    title: 'Cheat Clip Pro Offline',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (process.env.CCP_SMOKE) {
      console.log('CCP_SMOKE_OK');
      setTimeout(() => app.quit(), 800);
    }
  });
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    try { fs.mkdirSync(modelsDir(), { recursive: true }); } catch (e) {}
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

/* ---------------- Paths helper ---------------- */
function getBinPaths() {
  if (process.platform === 'win32') {
    const resBin = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, 'resources', 'bin');
    return {
      platform: 'win32',
      ffmpeg: path.join(resBin, 'ffmpeg.exe'),
      ffprobe: path.join(resBin, 'ffprobe.exe'),
      ytdlp: path.join(resBin, 'yt-dlp.exe'),
      binDir: resBin,
      assetsDir: app.isPackaged
        ? path.join(process.resourcesPath, 'assets')
        : path.join(__dirname, 'assets'),
      fontsDir: app.isPackaged
        ? path.join(process.resourcesPath, 'fonts')
        : path.join(__dirname, 'resources', 'fonts')
    };
  }
  // Linux dev environment
  return {
    platform: 'linux',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    ytdlp: 'yt-dlp',
    binDir: '.',
    assetsDir: path.join(__dirname, 'assets'),
    fontsDir: path.join(__dirname, 'resources', 'fonts')
  };
}

/* ---------------- IPC: dialog & shell ---------------- */
ipcMain.handle('dialog:file', async (e, kind) => {
  const filters = kind === 'video'
    ? [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'] }]
    : kind === 'audio'
      ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
      : [{ name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:openPath', async (e, p) => shell.openPath(p));
ipcMain.handle('shell:showItem', async (e, p) => shell.showItemInFolder(p));

ipcMain.handle('app:info', async () => {
  return {
    version: app.getVersion(),
    outputDir: getDefaultOutput(),
    modelsDir: modelsDir(),
    platform: process.platform
  };
});

function getDefaultOutput() {
  try {
    const vid = app.getPath('videos');
    return path.join(vid, 'Cheat Clip Pro');
  } catch (err) {
    try { return path.join(app.getPath('documents'), 'Cheat Clip Pro'); }
    catch (e2) { return path.join(app.getPath('home'), 'Cheat Clip Pro'); }
  }
}

/* ---------------- IPC: model status & download ---------------- */
function modelStatusOne(dir, org, name) {
  const base = path.join(dir, org, name);
  if (!fs.existsSync(base)) return { downloaded: false, size: 0 };
  let size = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d); } catch (e) { return; }
    for (const f of items) {
      const fp = path.join(d, f);
      let st;
      try { st = fs.statSync(fp); } catch (e) { continue; }
      if (st.isDirectory()) walk(fp); else size += st.size;
    }
  };
  walk(base);
  return { downloaded: size > 512 * 1024, size };
}

ipcMain.handle('models:status', async () => {
  const dir = modelsDir();
  return {
    dir,
    asr: modelStatusOne(dir, 'Xenova', 'whisper-base'),
    llm: modelStatusOne(dir, 'Xenova', 'Qwen1.5-0.5B-Chat')
  };
});

ipcMain.handle('models:download', async () => {
  try {
    const ai = require('./lib/ai');
    await ai.init(modelsDir(), MODELS);
    await ai.ensureASR((p) => sendEvt('model-progress', p));
    await ai.ensureLLM((p) => sendEvt('model-progress', p));
    sendEvt('models-ready', {});
    const dir = modelsDir();
    return {
      ok: true,
      asr: modelStatusOne(dir, 'Xenova', 'whisper-base'),
      llm: modelStatusOne(dir, 'Xenova', 'Qwen1.5-0.5B-Chat')
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* ---------------- IPC: job ---------------- */
ipcMain.handle('job:start', async (e, cfg) => {
  jobCancelFlag = false;
  activeChildren = [];
  const bins = getBinPaths();
  try {
    const job = require('./lib/job');
    const result = await job.runJob({
      cfg, bins, modelsDir: modelsDir(),
      isCancelled: () => jobCancelFlag,
      registerChild: (c) => activeChildren.push(c),
      evt: sendEvt,
      appVersion: app.getVersion()
    });
    return result;
  } catch (err) {
    sendEvt('job-error', { message: String(err && err.message || err) });
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('job:cancel', async () => {
  jobCancelFlag = true;
  for (const c of activeChildren) {
    try { c.kill('SIGKILL'); } catch (e) {}
  }
  return true;
});
