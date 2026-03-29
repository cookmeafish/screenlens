const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')

let overlayWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Ctrl+Shift+S to capture.')
})

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds
  console.log('[Overlay] Display:', width, 'x', height)

  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  })

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.webContents.on('console-message', (_, l, m) => console.log('[Renderer]', m))
  overlayWindow.webContents.on('did-finish-load', () => console.log('[Overlay] Loaded'))

  if (process.argv.includes('--dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Capture triggered')

    // If visible, dismiss first
    if (overlayWindow.isVisible()) {
      overlayWindow.hide()
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      overlayWindow.webContents.send('overlay-dismiss')
      await new Promise(r => setTimeout(r, 200))
    }

    // Hide to avoid capturing ourselves
    overlayWindow.hide()
    await new Promise(r => setTimeout(r, 300))

    try {
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: display.size,
      })
      if (!sources.length) return

      const dataUrl = sources[0].thumbnail.toDataURL()
      console.log('[Overlay] Screenshot:', dataUrl.length, 'chars')

      // Show overlay, allow mouse interaction on drawn areas
      overlayWindow.showInactive()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.setIgnoreMouseEvents(false)

      overlayWindow.webContents.send('overlay-capture', dataUrl)
    } catch (e) { console.error('[Overlay] Error:', e) }
  })
}

ipcMain.on('overlay-dismiss', () => {
  console.log('[Overlay] Dismiss')
  if (overlayWindow) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.hide()
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
