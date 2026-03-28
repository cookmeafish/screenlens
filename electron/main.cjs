const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')

const VITE_URL = 'http://localhost:3000'
let overlayWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Press Ctrl+Shift+S to capture screen.')
})

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds
  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  })

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.hide()

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Capturing screen...')
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: screen.getPrimaryDisplay().size,
      })
      if (!sources.length) {
        console.error('[Overlay] No screen sources found')
        return
      }
      const screenshot = sources[0].thumbnail.toDataURL()
      console.log('[Overlay] Screenshot captured, showing overlay')

      overlayWindow.show()
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.webContents.send('overlay-capture', screenshot)
    } catch (err) {
      console.error('[Overlay] Capture failed:', err.message)
    }
  })
}

ipcMain.on('overlay-dismiss', () => {
  console.log('[Overlay] Dismissing')
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.hide()
})

ipcMain.on('set-ignore-mouse', (_, ignore) => {
  overlayWindow.setIgnoreMouseEvents(ignore, { forward: true })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
