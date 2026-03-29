// ScreenLens Overlay — canvas-based transparent overlay
const VITE_URL = 'http://localhost:3000'
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
let words = []
let tooltip = null
let statusEl = null
let imgW = 0, imgH = 0

function setCanvasSize() {
  const dpr = window.devicePixelRatio || 1
  const w = window.innerWidth, h = window.innerHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  ctx.scale(dpr, dpr)
  console.log('[Overlay] Canvas:', w, 'x', h, 'dpr:', dpr)
}
setCanvasSize()
window.addEventListener('resize', () => { setCanvasSize(); draw() })

function status(msg, loading) {
  if (statusEl) statusEl.remove()
  statusEl = document.createElement('div')
  statusEl.className = 'status-bar'
  statusEl.innerHTML = (loading ? '<span class="dot"></span>' : '') + msg
  document.body.appendChild(statusEl)
}

function draw() {
  const w = window.innerWidth, h = window.innerHeight
  ctx.clearRect(0, 0, w, h)
  const sx = imgW > 0 ? w / imgW : 1, sy = imgH > 0 ? h / imgH : 1
  words.forEach(word => {
    const x = word.bbox.x0 * sx, y = word.bbox.y0 * sy
    const bw = (word.bbox.x1 - word.bbox.x0) * sx, bh = (word.bbox.y1 - word.bbox.y0) * sy
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(x, y, bw, bh)
    ctx.strokeStyle = '#58a6ff'
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, bw, bh)
    // Draw translation text
    if (word.translation) {
      ctx.font = 'bold 11px JetBrains Mono, monospace'
      ctx.fillStyle = '#58a6ff'
      ctx.fillText(word.translation, x + 2, y + bh + 13)
    }
  })
}

canvas.addEventListener('mousemove', e => {
  const mx = e.clientX, my = e.clientY
  const w = window.innerWidth, h = window.innerHeight
  const sx = imgW > 0 ? w / imgW : 1, sy = imgH > 0 ? h / imgH : 1
  const hit = words.find(word => {
    const x = word.bbox.x0 * sx, y = word.bbox.y0 * sy
    const bw = (word.bbox.x1 - word.bbox.x0) * sx, bh = (word.bbox.y1 - word.bbox.y0) * sy
    return mx >= x && mx <= x + bw && my >= y && my <= y + bh
  })
  if (hit) { showTip(hit, mx, my); canvas.style.cursor = 'pointer' }
  else { hideTip(); canvas.style.cursor = 'default' }
})

function showTip(w, mx, my) {
  hideTip()
  const t = document.createElement('div')
  t.className = 'tooltip'
  t.innerHTML = '<div class="tw">' + w.text + '</div>'
    + (w.translation ? '<div class="tt">&rarr; ' + w.translation + '</div>' : '')
    + (w.pronunciation ? '<div class="tp">/' + w.pronunciation + '/</div>' : '')
    + (w.synonyms && w.synonyms.length ? '<div class="ts">Syn: ' + w.synonyms.join(', ') + '</div>' : '')
  t.style.left = Math.min(mx + 15, window.innerWidth - 370) + 'px'
  t.style.top = (my > 100 ? (my - 10) + 'px' : (my + 25) + 'px')
  if (my > 100) t.style.transform = 'translateY(-100%)'
  document.body.appendChild(t)
  tooltip = t
}
function hideTip() { if (tooltip) { tooltip.remove(); tooltip = null } }

function loadImg(url) {
  return new Promise(resolve => { const i = new Image(); i.onload = () => resolve(i); i.src = url })
}

let Tesseract = null
async function loadTesseract() {
  if (Tesseract) return
  status('Loading OCR...', true)
  await new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    s.onload = () => { Tesseract = window.Tesseract; res() }
    s.onerror = rej
    document.head.appendChild(s)
  })
}

async function getConfig() {
  try {
    const [keys, cfg] = await Promise.all([
      fetch(VITE_URL + '/api/keys').then(r => r.json()),
      fetch(VITE_URL + '/api/config').then(r => r.json()),
    ])
    return { keys, cfg }
  } catch { return null }
}

async function translate(ocrWords, apiKey, from, to) {
  status('Translating...', true)
  const body = JSON.stringify({ words: ocrWords.slice(0, 80).map(w => ({ i: w.i, w: w.text })), from, to, context: ocrWords.map(w => w.text).join(' ').substring(0, 500) })
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, system: 'Translate words. Return JSON array: [{"i":0,"w":"word","t":"translation","s":[],"c":"foreign","p":"noun","r":"pron"}]. Output ONLY raw JSON.', messages: [{ role: 'user', content: body }] }),
  })
  if (!r.ok) throw new Error('API ' + r.status)
  const d = await r.json()
  try { return JSON.parse(d.content[0].text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) } catch { return [] }
}

async function process(dataUrl) {
  words = []
  hideTip()
  status('Processing...', true)

  const img = await loadImg(dataUrl)
  imgW = img.naturalWidth; imgH = img.naturalHeight
  console.log('[Overlay] Image:', imgW, 'x', imgH)

  const c = await getConfig()
  if (!c) { status('Cannot connect. Run npm run dev.'); return }
  const apiKey = c.keys && c.keys.anthropic
  if (!apiKey) { status('No API key. Set in web app.'); return }

  await loadTesseract()
  status('OCR...', true)
  const r = await Tesseract.recognize(dataUrl, 'spa+eng', {
    logger: m => { if (m.status === 'recognizing text') status('OCR ' + Math.round(m.progress * 100) + '%', true) }
  })
  const ocrWords = r.data.words.filter(w => w.confidence > 40 && w.text.trim().length > 1).map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox }))
  console.log('[Overlay] OCR:', ocrWords.length, 'words')
  if (!ocrWords.length) { status('No text found.'); return }

  const from = c.cfg && c.cfg.language !== 'auto' ? c.cfg.language : 'Spanish'
  const to = (c.cfg && c.cfg.targetLang) || 'English'
  const trans = await translate(ocrWords, apiKey, from, to)

  words = ocrWords.map(w => {
    const t = trans.find(tr => tr.i === w.i)
    return { ...w, translation: t && t.t || '', synonyms: t && t.s || [], category: t && t.c || 'foreign', pronunciation: t && t.r || '' }
  }).filter(w => w.category !== 'number')

  console.log('[Overlay] Rendered:', words.length)
  draw()
  status(words.length + ' words. Hover for translations. ESC to close.')
}

function clearAll() {
  words = []; imgW = 0; imgH = 0
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  hideTip()
  if (statusEl) { statusEl.remove(); statusEl = null }
}

if (window.overlayAPI) {
  window.overlayAPI.onCapture(url => { console.log('[Overlay] Capture'); process(url) })
  window.overlayAPI.onDismiss(() => { clearAll() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { clearAll(); window.overlayAPI.dismiss() } })
}
console.log('[Overlay] Ready')
