// ScreenLens Overlay — canvas-based rendering (no CSS stacking issues)
const VITE_URL = 'http://localhost:3000'
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')

let words = [] // rendered words with screen coords
let tooltip = null
let statusEl = null
let screenshotImg = null

console.log('[Overlay] Loaded. window:', window.innerWidth, 'x', window.innerHeight)

// ─── Status ─────────────────────────────────────────────────────────────
function status(msg, loading) {
  if (statusEl) statusEl.remove()
  statusEl = document.createElement('div')
  statusEl.className = 'status-bar'
  statusEl.innerHTML = (loading ? '<span class="dot"></span>' : '') + msg
  document.body.appendChild(statusEl)
}

// ─── Canvas resize ──────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  if (screenshotImg) draw()
}
window.addEventListener('resize', resizeCanvas)
resizeCanvas()

// ─── Draw everything on canvas ──────────────────────────────────────────
function draw() {
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)

  // Draw screenshot
  if (screenshotImg) {
    ctx.drawImage(screenshotImg, 0, 0, W, H)
  }

  // Draw word boxes
  words.forEach(w => {
    // Yellow highlight box
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(w.sx, w.sy, w.sw, w.sh)

    // Semi-transparent fill
    ctx.fillStyle = 'rgba(255, 255, 0, 0.12)'
    ctx.fillRect(w.sx, w.sy, w.sw, w.sh)
  })

  console.log('[Overlay] Drew', words.length, 'boxes on canvas', W, 'x', H)
}

// ─── Mouse interaction ──────────────────────────────────────────────────
canvas.addEventListener('mousemove', (e) => {
  const mx = e.clientX, my = e.clientY
  const hit = words.find(w => mx >= w.sx && mx <= w.sx + w.sw && my >= w.sy && my <= w.sy + w.sh)
  if (hit) {
    showTooltip(hit, mx, my)
    canvas.style.cursor = 'pointer'
  } else {
    hideTooltip()
    canvas.style.cursor = 'default'
  }
})

function showTooltip(w, mx, my) {
  hideTooltip()
  const t = document.createElement('div')
  t.className = 'tooltip'
  t.innerHTML = '<div class="tw">' + w.text + '</div>'
    + (w.translation ? '<div class="tt">&rarr; ' + w.translation + '</div>' : '')
    + (w.pronunciation ? '<div class="tp">/' + w.pronunciation + '/</div>' : '')
    + (w.synonyms && w.synonyms.length ? '<div class="ts">Syn: ' + w.synonyms.join(', ') + '</div>' : '')
  t.style.left = Math.min(mx + 10, window.innerWidth - 360) + 'px'
  t.style.top = (my > 100 ? my - 10 + 'px' : my + 20 + 'px')
  if (my > 100) t.style.transform = 'translateY(-100%)'
  document.body.appendChild(t)
  tooltip = t
}

function hideTooltip() {
  if (tooltip) { tooltip.remove(); tooltip = null }
}

// ─── Load image ─────────────────────────────────────────────────────────
function loadImage(dataUrl) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.src = dataUrl
  })
}

// ─── OCR ────────────────────────────────────────────────────────────────
let Tesseract = null
async function loadTesseract() {
  if (Tesseract) return
  status('Loading OCR engine...', true)
  await new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    s.onload = () => { Tesseract = window.Tesseract; res() }
    s.onerror = rej
    document.head.appendChild(s)
  })
}

async function runOCR(dataUrl) {
  await loadTesseract()
  status('Running OCR...', true)
  const r = await Tesseract.recognize(dataUrl, 'spa+eng', {
    logger: m => { if (m.status === 'recognizing text') status('OCR ' + Math.round(m.progress * 100) + '%', true) }
  })
  const w = r.data.words.filter(w => w.confidence > 40 && w.text.trim().length > 1)
    .map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox, confidence: w.confidence }))
  console.log('[Overlay] OCR:', w.length, 'words')
  return w
}

// ─── Translation ────────────────────────────────────────────────────────
async function getConfig() {
  try {
    const [keys, config] = await Promise.all([
      fetch(VITE_URL + '/api/keys').then(r => r.json()),
      fetch(VITE_URL + '/api/config').then(r => r.json()),
    ])
    return { keys, config }
  } catch (e) { return null }
}

async function translate(ocrWords, apiKey, from, to) {
  status('Translating ' + ocrWords.length + ' words...', true)
  const body = JSON.stringify({
    words: ocrWords.slice(0, 80).map(w => ({ i: w.i, w: w.text })),
    from: from || 'Spanish', to: to || 'English',
    context: ocrWords.map(w => w.text).join(' ').substring(0, 500),
  })
  const prompt = 'Translate words. Return JSON array: [{"i":0,"w":"word","t":"translation","s":[],"c":"foreign","p":"noun","r":"pron"}]. Output ONLY raw JSON.'
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, system: prompt, messages: [{ role: 'user', content: body }] }),
  })
  if (!resp.ok) throw new Error('API ' + resp.status)
  const data = await resp.json()
  try { return JSON.parse(data.content[0].text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) }
  catch { return [] }
}

// ─── Main process ───────────────────────────────────────────────────────
async function process(dataUrl) {
  words = []
  hideTooltip()
  if (statusEl) statusEl.remove()

  // Load and draw screenshot immediately
  status('Loading screenshot...', true)
  screenshotImg = await loadImage(dataUrl)
  console.log('[Overlay] Image:', screenshotImg.naturalWidth, 'x', screenshotImg.naturalHeight)
  resizeCanvas()
  draw() // draw screenshot immediately

  // Get config
  const cfg = await getConfig()
  if (!cfg) { status('Cannot connect to ScreenLens. Run npm run dev first.'); return }
  const apiKey = cfg.keys && cfg.keys.anthropic
  if (!apiKey) { status('No API key set. Configure in web app first.'); return }

  // OCR
  const ocrWords = await runOCR(dataUrl)
  if (!ocrWords.length) { status('No text found.'); return }

  // Translate
  const from = cfg.config && cfg.config.language !== 'auto' ? cfg.config.language : 'Spanish'
  const to = (cfg.config && cfg.config.targetLang) || 'English'
  const trans = await translate(ocrWords, apiKey, from, to)

  // Merge and calculate screen coordinates
  const imgW = screenshotImg.naturalWidth, imgH = screenshotImg.naturalHeight
  const scrW = canvas.width, scrH = canvas.height
  const sx = scrW / imgW, sy = scrH / imgH
  console.log('[Overlay] Scale:', sx.toFixed(3), 'x', sy.toFixed(3), 'img:', imgW, 'x', imgH, 'canvas:', scrW, 'x', scrH)

  words = ocrWords.map(w => {
    const t = trans.find(tr => tr.i === w.i)
    return {
      text: w.text,
      translation: t && t.t || '',
      synonyms: t && t.s || [],
      category: t && t.c || 'foreign',
      pronunciation: t && t.r || '',
      // Screen coordinates
      sx: Math.round(w.bbox.x0 * sx),
      sy: Math.round(w.bbox.y0 * sy),
      sw: Math.round((w.bbox.x1 - w.bbox.x0) * sx),
      sh: Math.round((w.bbox.y1 - w.bbox.y0) * sy),
    }
  }).filter(w => w.category !== 'number' && w.sw > 3 && w.sh > 3)

  console.log('[Overlay] Final:', words.length, 'words with coords')
  if (words.length > 0) {
    console.log('[Overlay] First box:', words[0].text, 'at', words[0].sx, words[0].sy, words[0].sw, 'x', words[0].sh)
  }

  draw() // redraw with boxes
  status(words.length + ' words. Hover for translations. ESC to close.')
}

function clearAll() {
  words = []
  screenshotImg = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  hideTooltip()
  if (statusEl) { statusEl.remove(); statusEl = null }
}

// ─── IPC ────────────────────────────────────────────────────────────────
if (window.overlayAPI) {
  window.overlayAPI.onCapture(dataUrl => {
    console.log('[Overlay] Capture received, len=' + dataUrl.length)
    process(dataUrl)
  })
  window.overlayAPI.onDismiss(() => { clearAll() })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearAll(); window.overlayAPI.dismiss() }
  })
} else {
  console.error('[Overlay] overlayAPI not available!')
}
