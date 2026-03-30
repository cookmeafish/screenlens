const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const VITE_URL = 'http://localhost:3000'
const SCREENSHOT_FILE = path.resolve('electron/last-capture.png')
let overlayWindow = null
let selectorWindow = null

app.whenReady().then(() => {
  createOverlay()
  registerShortcuts()
  console.log('[Overlay] Ready. Ctrl+Shift+S to capture, Ctrl+Shift+A to area-select.')
})

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds
  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  overlayWindow.loadURL(VITE_URL + '?overlay=true')

  // ESC / window.close() → hide instead of closing
  overlayWindow.on('close', (e) => {
    e.preventDefault()
    hideOverlay()
  })

  overlayWindow.webContents.on('console-message', (_, l, m) => console.log('[Renderer]', m))
  overlayWindow.webContents.on('did-finish-load', () => console.log('[Overlay] Web app loaded'))
}

function showOverlay() {
  const bounds = screen.getPrimaryDisplay().bounds
  overlayWindow.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  overlayWindow.show()
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.focus()
  // Register ESC only while overlay is visible so it doesn't steal ESC from other apps
  globalShortcut.register('Escape', () => {
    console.log('[Overlay] ESC — hiding')
    hideOverlay()
  })
}

function hideOverlay() {
  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
  if (overlayWindow) overlayWindow.hide()
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Overlay] Capture triggered')
    if (overlayWindow.isVisible()) {
      hideOverlay()
      await new Promise(r => setTimeout(r, 200))
    }
    await new Promise(r => setTimeout(r, 300))

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size,
      })
      if (!sources.length) return

      fs.writeFileSync(SCREENSHOT_FILE, sources[0].thumbnail.toPNG())
      console.log('[Overlay] Screenshot saved')

      // Hide page content so old screenshot doesn't flash, then show overlay
      await overlayWindow.webContents.executeJavaScript(`
        document.body.style.opacity = '0';
        window.dispatchEvent(new CustomEvent('overlay-reset'));
      `)

      showOverlay()

      overlayWindow.webContents.executeJavaScript(`
        window.__overlayScreenshot = '/api/overlay-screenshot?' + Date.now();
        window.dispatchEvent(new CustomEvent('overlay-capture'));
      `)
    } catch (e) { console.error('[Overlay] Error:', e) }
  })

  // Ctrl+Shift+A — lightweight transparent selector window for drawing
  globalShortcut.register('CommandOrControl+Shift+A', async () => {
    console.log('[Overlay] Area-select triggered')
    if (overlayWindow.isVisible()) {
      hideOverlay()
      await new Promise(r => setTimeout(r, 200))
    }
    if (selectorWindow) { selectorWindow.destroy(); selectorWindow = null }

    const bounds = screen.getPrimaryDisplay().bounds
    selectorWindow = new BrowserWindow({
      x: 0, y: 0, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, hasShadow: false, resizable: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    selectorWindow.setAlwaysOnTop(true, 'screen-saver')

    // Minimal HTML for drawing a selection rectangle
    selectorWindow.loadURL('data:text/html,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  *{margin:0;padding:0}
  html,body{background:transparent;overflow:hidden;width:100vw;height:100vh;cursor:crosshair;user-select:none}
  #hint{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(22,27,34,.9);border:1px solid #2a3040;border-radius:8px;padding:12px 20px;color:#8b949e;font:13px monospace;pointer-events:none}
  #sel{position:fixed;border:2px solid #58a6ff;background:rgba(88,166,255,.08);border-radius:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none;display:none}
</style></head><body>
<div id="hint">Click and drag to select an area</div>
<div id="sel"></div>
<script>
  const sel=document.getElementById('sel'),hint=document.getElementById('hint')
  let sx,sy,drawing=false
  document.addEventListener('mousedown',e=>{
    sx=e.clientX;sy=e.clientY;drawing=true;hint.style.display='none'
    sel.style.display='block'
  })
  document.addEventListener('mousemove',e=>{
    if(!drawing)return
    const x=Math.min(sx,e.clientX),y=Math.min(sy,e.clientY)
    const w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy)
    sel.style.left=x+'px';sel.style.top=y+'px';sel.style.width=w+'px';sel.style.height=h+'px'
  })
  document.addEventListener('mouseup',e=>{
    if(!drawing)return;drawing=false
    const x=Math.min(sx,e.clientX),y=Math.min(sy,e.clientY)
    const w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy)
    if(w<10||h<10)return
    document.title=JSON.stringify({x,y,w,h})
  })
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.title='cancel'})
</script></body></html>`))

    // Watch for title change = selection done or cancel
    selectorWindow.on('page-title-updated', async (e, title) => {
      e.preventDefault()
      selectorWindow.destroy()
      selectorWindow = null

      if (title === 'cancel') return

      try {
        const rect = JSON.parse(title)
        // Brief delay for selector window to fully disappear
        await new Promise(r => setTimeout(r, 100))

        // Capture the actual live screen now
        const sources = await desktopCapturer.getSources({
          types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size,
        })
        if (!sources.length) return

        const fullPng = sources[0].thumbnail
        fs.writeFileSync(SCREENSHOT_FILE, fullPng.toPNG())
        console.log('[Overlay] Screenshot captured after area-select')

        // Reset overlay state
        await overlayWindow.webContents.executeJavaScript(`
          document.body.style.opacity = '0';
          window.dispatchEvent(new CustomEvent('overlay-reset'));
        `)

        // Resize overlay to just the selection area — rest of desktop stays free
        const pad = 6
        overlayWindow.setBounds({
          x: Math.max(0, rect.x - pad),
          y: Math.max(0, rect.y - pad),
          width: rect.w + pad * 2,
          height: rect.h + pad * 2,
        })
        overlayWindow.show()
        overlayWindow.setAlwaysOnTop(true, 'screen-saver')
        overlayWindow.focus()
        // Register ESC to dismiss
        if (!globalShortcut.isRegistered('Escape')) {
          globalShortcut.register('Escape', () => {
            console.log('[Overlay] ESC — hiding')
            hideOverlay()
          })
        }

        const dispBounds = screen.getPrimaryDisplay().bounds
        overlayWindow.webContents.executeJavaScript(`
          window.__overlayScreenshot = '/api/overlay-screenshot?' + Date.now();
          window.__areaSelectRect = ${JSON.stringify({ ...rect, pad, screenW: dispBounds.width, screenH: dispBounds.height })};
          window.dispatchEvent(new CustomEvent('overlay-area-captured'));
        `)
      } catch (err) { console.error('[Overlay] Area-select error:', err) }
    })

    selectorWindow.on('closed', () => { selectorWindow = null })
  })
}

ipcMain.on('overlay-dismiss', () => {
  hideOverlay()
})

// React requests a screenshot capture (for area-select: capture after drawing)
ipcMain.handle('capture-screenshot', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size,
    })
    if (!sources.length) return null
    fs.writeFileSync(SCREENSHOT_FILE, sources[0].thumbnail.toPNG())
    console.log('[Overlay] Screenshot captured on demand')
    return '/api/overlay-screenshot?' + Date.now()
  } catch (e) {
    console.error('[Overlay] Capture error:', e)
    return null
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
