const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startJob: (cfg) => ipcRenderer.invoke('job:start', cfg),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  pickFile: (kind) => ipcRenderer.invoke('dialog:file', kind),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  statFile: (p) => ipcRenderer.invoke('fs:stat', p),
  appInfo: () => ipcRenderer.invoke('app:info'),
  modelsStatus: () => ipcRenderer.invoke('models:status'),
  modelsDownload: () => ipcRenderer.invoke('models:download'),
  on: (cb) => ipcRenderer.on('evt', (e, data) => cb(data))
});
