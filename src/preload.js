const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('claudeWidget', {
  onUsageUpdate: (callback) => ipcRenderer.on('usage-update', (event, data) => callback(data)),
  onCodexUsageUpdate: (callback) => ipcRenderer.on('codex-usage-update', (event, data) => callback(data)),
  onRefreshState: (callback) => ipcRenderer.on('refresh-state', (event, data) => callback(data)),
  refresh: () => ipcRenderer.send('refresh-usage'),
  openLogin: () => ipcRenderer.send('open-login'),
  quit: () => ipcRenderer.send('quit-app'),
  resizeByDelta: (deltaX) => ipcRenderer.invoke('resize-widget-by-delta', deltaX)
})
