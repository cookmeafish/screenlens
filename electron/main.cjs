const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const VITE_URL = 'http://localhost:3000'
const SCREENSHOT_FILE = path.resolve('electron/last-capture.png')
let overlayWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Ctrl+Shift+S to capture.')
})

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds
  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0e1117',
  })

  overlayWindow.loadURL(VITE_URL + '?overlay=true')

  // ESC / window.close() → hide instead of closing
  overlayWindow.on('close', (e) => {
    e.preventDefault()
    overlayWindow.hide()
  })

  overlayWindow.webContents.on('console-message', (_, l, m) => console.log('[Renderer]', m))
  overlayWindow.webContents.on('did-finish-load', () => console.log('[Overlay] Web app loaded'))
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Capture triggered')
    if (overlayWindow.isVisible()) {
      overlayWindow.hide()
      await new Promise(r => setTimeout(r, 200))
    }
    overlayWindow.hide()
    await new Promise(r => setTimeout(r, 300))

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size,
      })
      if (!sources.length) return

      fs.writeFileSync(SCREENSHOT_FILE, sources[0].thumbnail.toPNG())
      console.log('[Overlay] Screenshot saved')

      overlayWindow.show()
      overlayWindow.maximize()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.focus()

      overlayWindow.webContents.executeJavaScript(`
        window.__overlayScreenshot = '/api/overlay-screenshot?' + Date.now();
        window.dispatchEvent(new CustomEvent('overlay-capture'));
      `)
    } catch (e) { console.error('[Overlay] Error:', e) }
  })
}

ipcMain.on('overlay-dismiss', () => {
  if (overlayWindow) overlayWindow.hide()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
