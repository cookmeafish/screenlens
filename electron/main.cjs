const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const VITE_URL = 'http://localhost:3000'
const SCREENSHOT_FILE = path.resolve('electron/last-capture.png')
let overlayWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Press Ctrl+Shift+S to capture.')
})

function createOverlay() {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  console.log('[Overlay] Display:', width, 'x', height)

  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0e1117',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  })

  // Load the web app
  overlayWindow.loadURL(VITE_URL + '?overlay=true')

  overlayWindow.webContents.on('console-message', (_, level, message) => {
    console.log('[Renderer]', message)
  })
  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('[Overlay] Web app loaded in overlay window')
  })
  if (process.argv.includes('--dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Ctrl+Shift+S pressed')

    // Hide overlay before capturing
    if (overlayWindow.isVisible()) overlayWindow.hide()
    await new Promise(r => setTimeout(r, 300))

    try {
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: display.size,
      })
      if (!sources.length) { console.error('[Overlay] No sources'); return }

      // Save screenshot as PNG file
      const pngBuffer = sources[0].thumbnail.toPNG()
      fs.writeFileSync(SCREENSHOT_FILE, pngBuffer)
      console.log('[Overlay] Screenshot saved:', pngBuffer.length, 'bytes')

      // Show overlay and tell the web app to load the screenshot
      overlayWindow.show()
      overlayWindow.maximize()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.focus()

      // Execute JS in the web app to trigger loading
      overlayWindow.webContents.executeJavaScript(`
        window.__overlayScreenshot = '/api/overlay-screenshot?' + Date.now();
        window.dispatchEvent(new CustomEvent('overlay-capture'));
      `)
      console.log('[Overlay] Triggered capture in web app')
    } catch (err) {
      console.error('[Overlay] Capture failed:', err)
    }
  })
}

ipcMain.on('overlay-dismiss', () => {
  console.log('[Overlay] Dismissed')
  if (overlayWindow) overlayWindow.hide()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
