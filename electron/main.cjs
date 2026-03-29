const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')

let overlayWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Press Ctrl+Shift+S to capture screen.')
})

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds
  console.log('[Overlay] Creating window:', width, 'x', height)

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

  // Pipe renderer console to terminal
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

    // Hide overlay first so we don't screenshot it
    overlayWindow.hide()
    console.log('[Overlay] Window hidden for capture')

    // Small delay to let the window fully hide
    await new Promise(r => setTimeout(r, 200))

    try {
      const display = screen.getPrimaryDisplay()
      console.log('[Overlay] Display size:', display.size.width, 'x', display.size.height, 'scaleFactor:', display.scaleFactor)

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height },
      })

      if (!sources.length) {
        console.error('[Overlay] No screen sources found')
        return
      }

      const screenshot = sources[0].thumbnail.toDataURL()
      console.log('[Overlay] Screenshot captured, size:', screenshot.length, 'chars')

      // Show overlay and bring to front
      overlayWindow.show()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.focus()

      // Send screenshot to renderer
      overlayWindow.webContents.send('overlay-capture', screenshot)
      console.log('[Overlay] Screenshot sent to renderer')
    } catch (err) {
      console.error('[Overlay] Capture failed:', err.message)
    }
  })
}

// Dismiss overlay
ipcMain.on('overlay-dismiss', () => {
  console.log('[Overlay] Dismiss requested')
  if (overlayWindow) {
    overlayWindow.webContents.send('overlay-dismiss')
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.hide()
    console.log('[Overlay] Hidden')
  }
})

ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(ignore, { forward: true })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
