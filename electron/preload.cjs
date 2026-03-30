const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onCapture: (callback) => ipcRenderer.on('overlay-capture', (_, data) => callback(data)),
  onDismiss: (callback) => ipcRenderer.on('overlay-dismiss', () => callback()),
  dismiss: () => ipcRenderer.send('overlay-dismiss'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
})
