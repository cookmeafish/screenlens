// ScreenLens Overlay — transparent screen translation overlay
const VITE_URL = 'http://localhost:3000'
const root = document.getElementById('overlay-root')
let currentTooltip = null
let statusEl = null
let imgWidth = 0
let imgHeight = 0

console.log('[Overlay] Script loaded. Screen:', window.innerWidth, 'x', window.innerHeight)

// ─── Status Bar ─────────────────────────────────────────────────────────
function showStatus(msg, loading) {
  if (statusEl) statusEl.remove()
  statusEl = document.createElement('div')
  statusEl.className = 'status-bar'
  statusEl.innerHTML = loading ? '<span class="loading-dot"></span>' + msg : msg
  document.body.appendChild(statusEl)
}
function hideStatus() { if (statusEl) { statusEl.remove(); statusEl = null } }

// ─── Helpers ────────────────────────────────────────────────────────────
function getImageSize(dataUrl) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = dataUrl
  })
}

// ─── OCR ────────────────────────────────────────────────────────────────
let Tesseract = null
async function loadTesseract() {
  if (Tesseract) return
  showStatus('Loading OCR engine...', true)
  await new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    s.onload = () => { Tesseract = window.Tesseract; console.log('[Overlay] Tesseract ready'); res() }
    s.onerror = rej
    document.head.appendChild(s)
  })
}

async function runOCR(dataUrl) {
  await loadTesseract()
  showStatus('Running OCR...', true)
  const result = await Tesseract.recognize(dataUrl, 'spa+eng', {
    logger: m => { if (m.status === 'recognizing text') showStatus('OCR ' + Math.round(m.progress * 100) + '%', true) }
  })
  return result.data.words
    .filter(w => w.confidence > 40 && w.text.trim().length > 1)
    .map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox, confidence: w.confidence }))
}

// ─── Translation ────────────────────────────────────────────────────────
async function getConfig() {
  try {
    const [keys, config] = await Promise.all([
      fetch(VITE_URL + '/api/keys').then(r => r.json()),
      fetch(VITE_URL + '/api/config').then(r => r.json()),
    ])
    return { keys, config }
  } catch (e) { console.error('[Overlay] Config fetch failed:', e); return null }
}

async function translate(words, apiKey, from, to) {
  showStatus('Translating ' + words.length + ' words...', true)
  const body = JSON.stringify({
    words: words.slice(0, 80).map(w => ({ i: w.i, w: w.text })),
    from: from || 'Spanish', to: to || 'English',
    context: words.map(w => w.text).join(' ').substring(0, 500),
  })
  const prompt = 'Translate words. Return JSON array: [{"i":0,"w":"word","t":"translation","s":[],"c":"foreign","p":"noun","r":"pronunciation"}]. Output ONLY raw JSON.'
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, system: prompt, messages: [{ role: 'user', content: body }] }),
  })
  if (!resp.ok) throw new Error('API ' + resp.status)
  const data = await resp.json()
  const text = data.content[0].text
  try { return JSON.parse(text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) }
  catch { console.error('[Overlay] Parse failed:', text.substring(0, 100)); return [] }
}

// ─── Render ─────────────────────────────────────────────────────────────
function clearAll() {
  root.innerHTML = ''
  root.style.backgroundImage = ''
  if (currentTooltip) { currentTooltip.remove(); currentTooltip = null }
  hideStatus()
}

function renderBoxes(words) {
  const sw = window.innerWidth, sh = window.innerHeight
  const sx = imgWidth > 0 ? sw / imgWidth : 1
  const sy = imgHeight > 0 ? sh / imgHeight : 1
  console.log('[Overlay] Render: img=' + imgWidth + 'x' + imgHeight + ' screen=' + sw + 'x' + sh + ' scale=' + sx.toFixed(3) + 'x' + sy.toFixed(3))

  let count = 0
  words.forEach(w => {
    if (w.category === 'number') return
    const x = Math.round(w.bbox.x0 * sx), y = Math.round(w.bbox.y0 * sy)
    const bw = Math.round((w.bbox.x1 - w.bbox.x0) * sx), bh = Math.round((w.bbox.y1 - w.bbox.y0) * sy)
    if (bw < 5 || bh < 5) return

    const el = document.createElement('div')
    el.className = 'word-box'
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    el.style.width = bw + 'px'
    el.style.height = bh + 'px'
    el.onmouseenter = () => showTip(w, el)
    el.onmouseleave = () => hideTip()
    root.appendChild(el)
    count++
  })
  console.log('[Overlay] Rendered ' + count + ' boxes, root.children=' + root.children.length)
  showStatus(count + ' words. Hover for translations. ESC to close.')
}

function showTip(w, el) {
  hideTip()
  const t = document.createElement('div')
  t.className = 'tooltip'
  t.innerHTML = '<div class="word">' + w.text + '</div>'
    + (w.translation ? '<div class="translation">&rarr; ' + w.translation + '</div>' : '')
    + (w.pronunciation ? '<div class="pronunciation">/' + w.pronunciation + '/</div>' : '')
    + (w.synonyms && w.synonyms.length ? '<div class="synonyms">Syn: ' + w.synonyms.join(', ') + '</div>' : '')
  const r = el.getBoundingClientRect()
  t.style.left = Math.max(10, r.left) + 'px'
  t.style.top = (r.top > 80 ? r.top - 10 : r.bottom + 10) + 'px'
  if (r.top > 80) t.style.transform = 'translateY(-100%)'
  document.body.appendChild(t)
  currentTooltip = t
}
function hideTip() { if (currentTooltip) { currentTooltip.remove(); currentTooltip = null } }

// ─── Main ───────────────────────────────────────────────────────────────
async function process(dataUrl) {
  clearAll()

  // Set screenshot as background of root div
  root.style.backgroundImage = 'url(' + dataUrl + ')'
  showStatus('Processing...', true)

  const size = await getImageSize(dataUrl)
  imgWidth = size.w; imgHeight = size.h
  console.log('[Overlay] Screenshot: ' + imgWidth + 'x' + imgHeight)

  const cfg = await getConfig()
  if (!cfg) { showStatus('Cannot connect to ScreenLens. Is npm run dev running?'); return }
  const apiKey = cfg.keys && cfg.keys.anthropic
  if (!apiKey) { showStatus('No API key. Set one in the web app.'); return }

  const ocrWords = await runOCR(dataUrl)
  console.log('[Overlay] OCR: ' + ocrWords.length + ' words')
  if (!ocrWords.length) { showStatus('No text found.'); return }

  const from = cfg.config && cfg.config.language !== 'auto' ? cfg.config.language : 'Spanish'
  const to = cfg.config && cfg.config.targetLang || 'English'
  const trans = await translate(ocrWords, apiKey, from, to)

  const merged = ocrWords.map(w => {
    const t = trans.find(tr => tr.i === w.i)
    return { ...w, translation: t && t.t || '', synonyms: t && t.s || [], category: t && t.c || 'foreign', partOfSpeech: t && t.p || 'other', pronunciation: t && t.r || '' }
  })
  console.log('[Overlay] Merged: ' + merged.length + ' words')
  renderBoxes(merged)
}

// ─── IPC ────────────────────────────────────────────────────────────────
if (window.overlayAPI) {
  window.overlayAPI.onCapture(dataUrl => {
    console.log('[Overlay] Capture received, len=' + dataUrl.length)
    process(dataUrl)
  })
  window.overlayAPI.onDismiss(() => { console.log('[Overlay] Dismiss'); clearAll() })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearAll(); window.overlayAPI.dismiss() }
  })
}
