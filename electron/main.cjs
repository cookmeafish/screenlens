const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')

let overlayWindow = null

// Disable GPU acceleration to avoid compositing issues
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Press Ctrl+Shift+S to capture screen.')
})

function createOverlay() {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  console.log('[Overlay] Display:', width, 'x', height, 'scale:', display.scaleFactor)

  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      offscreen: false,
    },
  })

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))

  overlayWindow.webContents.on('console-message', (_, level, message) => {
    console.log('[Renderer]', message)
  })
  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('[Overlay] Page loaded')
  })
  if (process.argv.includes('--dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Ctrl+Shift+S pressed')

    // Hide overlay first
    overlayWindow.hide()
    await new Promise(r => setTimeout(r, 300))

    try {
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height },
      })
      if (!sources.length) { console.error('[Overlay] No sources'); return }

      const screenshot = sources[0].thumbnail.toDataURL()
      console.log('[Overlay] Screenshot captured:', screenshot.length, 'chars')

      // Show and maximize
      overlayWindow.show()
      overlayWindow.maximize()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.focus()

      overlayWindow.webContents.send('overlay-capture', screenshot)
      console.log('[Overlay] Sent to renderer')
    } catch (err) {
      console.error('[Overlay] Capture failed:', err)
    }
  })
}

ipcMain.on('overlay-dismiss', () => {
  console.log('[Overlay] Dismissed')
  if (overlayWindow) overlayWindow.hide()
})

ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(ignore, { forward: true })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
