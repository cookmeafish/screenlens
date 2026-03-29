// ScreenLens Overlay — transparent screen translation overlay
// Connects to Vite dev server at localhost:3000 for API access

const VITE_URL = 'http://localhost:3000'
const root = document.getElementById('overlay-root')

let currentTooltip = null
let statusEl = null
let screenshotWidth = 0
let screenshotHeight = 0

// ─── Status Bar ──────────────────────────────────────────────────────────────
function showStatus(msg, loading = false) {
  if (statusEl) statusEl.remove()
  statusEl = document.createElement('div')
  statusEl.className = 'status-bar'
  statusEl.innerHTML = loading ? `<span class="loading-dot"></span>${msg}` : msg
  document.body.appendChild(statusEl)
}

function hideStatus() {
  if (statusEl) { statusEl.remove(); statusEl = null }
}

// ─── Get image dimensions ───────────────────────────────────────────────────
function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.width, height: img.height })
    img.src = dataUrl
  })
}

// ─── OCR with Tesseract.js via CDN ──────────────────────────────────────────
let tesseractLoaded = false
let Tesseract = null

async function loadTesseract() {
  if (tesseractLoaded) return
  showStatus('Loading OCR engine...', true)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    script.onload = () => {
      Tesseract = window.Tesseract
      tesseractLoaded = true
      console.log('[Overlay] Tesseract loaded')
      resolve()
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

async function runOCR(dataUrl) {
  await loadTesseract()
  showStatus('Running OCR...', true)

  const result = await Tesseract.recognize(dataUrl, 'spa+eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        showStatus(`OCR: ${Math.round(m.progress * 100)}%`, true)
      }
    },
  })

  const words = result.data.words
    .filter((w) => w.confidence > 40 && w.text.trim().length > 1)
    .map((w, i) => ({
      i,
      text: w.text.trim(),
      bbox: w.bbox,
      confidence: w.confidence,
    }))

  console.log('[Overlay] OCR found', words.length, 'words')
  if (words.length > 0) {
    console.log('[Overlay] Sample bbox:', words[0].text, words[0].bbox)
  }
  return words
}

// ─── Translation via Vite server ────────────────────────────────────────────
async function getConfig() {
  try {
    const [keys, config] = await Promise.all([
      fetch(`${VITE_URL}/api/keys`).then((r) => r.json()),
      fetch(`${VITE_URL}/api/config`).then((r) => r.json()),
    ])
    return { keys, config }
  } catch (err) {
    console.error('[Overlay] Failed to get config:', err.message)
    return null
  }
}

async function translateWords(words, apiKey, fromLang, toLang) {
  showStatus(`Translating ${words.length} words...`, true)

  const context = words.map((w) => w.text).join(' ')
  const input = JSON.stringify({
    words: words.slice(0, 80).map((w) => ({ i: w.i, w: w.text })),
    from: fromLang || 'Spanish',
    to: toLang || 'English',
    context: context.substring(0, 500),
  })

  const prompt = `Translate words from one language to another. Classify each word by category and part of speech.

You receive JSON: {"words": [{"i":0,"w":"word1"},...], "from": "Language", "to": "Language", "context": "..."}

Return a JSON array. For each input word, return an object:
- "i": the SAME index number from the input
- "w": the SAME original word from the input
- "t": translation
- "s": 2-3 synonyms (empty array for articles/prepositions/names)
- "c": category — "foreign" | "name" | "target" | "number"
- "p": part of speech — "noun" | "verb" | "adj" | "adv" | "prep" | "art" | "conj" | "pron" | "other"
- "r": pronunciation guide

Output ONLY the raw JSON array. No markdown, no backticks.`

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: prompt,
      messages: [{ role: 'user', content: input }],
    }),
  })

  if (!resp.ok) throw new Error(`API ${resp.status}`)
  const data = await resp.json()
  const text = data.content[0].text

  try {
    return JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
  } catch {
    console.error('[Overlay] Failed to parse translation:', text.substring(0, 200))
    return []
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function clearOverlay() {
  root.innerHTML = ''
  if (currentTooltip) { currentTooltip.remove(); currentTooltip = null }
  hideStatus()
}

function renderWords(words) {
  hideStatus()

  // Calculate scale factor: screenshot coords → screen coords
  const screenW = window.innerWidth
  const screenH = window.innerHeight
  const scaleX = screenshotWidth > 0 ? screenW / screenshotWidth : 1
  const scaleY = screenshotHeight > 0 ? screenH / screenshotHeight : 1

  console.log('[Overlay] Rendering', words.length, 'words')
  console.log('[Overlay] Screenshot:', screenshotWidth, 'x', screenshotHeight)
  console.log('[Overlay] Screen:', screenW, 'x', screenH)
  console.log('[Overlay] Scale:', scaleX.toFixed(3), 'x', scaleY.toFixed(3))

  let rendered = 0
  let skipped = { noTranslation: 0, target: 0, number: 0, tooSmall: 0 }
  words.forEach((word) => {
    if (word.category === 'number') { skipped.number++; return }
    if (!word.translation && !word.text) { skipped.noTranslation++; return }

    const x0 = Math.round(word.bbox.x0 * scaleX)
    const y0 = Math.round(word.bbox.y0 * scaleY)
    const x1 = Math.round(word.bbox.x1 * scaleX)
    const y1 = Math.round(word.bbox.y1 * scaleY)
    const w = x1 - x0
    const h = y1 - y0

    if (w < 5 || h < 5) { skipped.tooSmall++; return }

    const box = document.createElement('div')
    box.className = 'word-box'
    box.style.left = x0 + 'px'
    box.style.top = y0 + 'px'
    box.style.width = Math.max(w, 30) + 'px'
    box.style.height = Math.max(h, 16) + 'px'

    // Add visible text label
    const label = document.createElement('div')
    label.className = 'word-label'
    label.textContent = word.translation || word.text
    box.appendChild(label)

    box.addEventListener('mouseenter', () => showTooltip(word, box))
    box.addEventListener('mouseleave', () => hideTooltip())

    root.appendChild(box)
    rendered++
  })

  console.log('[Overlay] Rendered', rendered, 'word boxes. Skipped:', JSON.stringify(skipped))
  showStatus(`${rendered} words. Hover to see translations. ESC to close.`)

  if (rendered === 0 && words.length > 0) {
    showStatus(`${words.length} words translated but 0 rendered. Check console for coordinate issues.`)
  }
}

function showTooltip(word, boxEl) {
  hideTooltip()
  const tt = document.createElement('div')
  tt.className = 'tooltip'

  let html = `<div class="word">${word.text}`
  if (word.partOfSpeech) {
    html += `<span class="pos-tag" style="color:${word.partOfSpeech === 'verb' ? '#d2a8ff' : '#58a6ff'};background:rgba(88,166,255,.12)">${word.partOfSpeech}</span>`
  }
  html += '</div>'

  if (word.translation) html += `<div class="translation">\u2192 ${word.translation}</div>`
  if (word.pronunciation) html += `<div class="pronunciation">/${word.pronunciation}/</div>`
  if (word.synonyms?.length) html += `<div class="synonyms">Synonyms: ${word.synonyms.join(', ')}</div>`

  tt.innerHTML = html

  // Position above the word box
  const rect = boxEl.getBoundingClientRect()
  let left = Math.max(10, rect.left)
  let top = rect.top - 10

  // If tooltip would go off-screen top, put it below
  if (top < 80) top = rect.bottom + 10
  else top = top // transform will handle the rest

  tt.style.left = left + 'px'
  tt.style.top = top + 'px'
  if (rect.top >= 80) tt.style.transform = 'translateY(-100%)'

  document.body.appendChild(tt)
  currentTooltip = tt
}

function hideTooltip() {
  if (currentTooltip) { currentTooltip.remove(); currentTooltip = null }
}

// ─── Main Flow ──────────────────────────────────────────────────────────────
async function processScreenshot(dataUrl) {
  clearOverlay()
  showStatus('Processing screenshot...', true)

  try {
    // Get screenshot dimensions for coordinate scaling
    const dims = await getImageDimensions(dataUrl)
    screenshotWidth = dims.width
    screenshotHeight = dims.height
    console.log('[Overlay] Screenshot dimensions:', dims.width, 'x', dims.height)

    // Get API config from Vite server
    const cfg = await getConfig()
    if (!cfg) { showStatus('Error: Cannot connect to ScreenLens (is npm run dev running?)'); return }

    const apiKey = cfg.keys?.anthropic
    if (!apiKey) { showStatus('Error: No API key configured. Set one in the web app first.'); return }

    // Run OCR
    const ocrWords = await runOCR(dataUrl)
    if (ocrWords.length === 0) { showStatus('No text found in screenshot.'); return }

    // Translate
    const fromLang = cfg.config?.language === 'auto' ? 'Spanish' : (cfg.config?.language || 'Spanish')
    const toLang = cfg.config?.targetLang || 'English'
    const translations = await translateWords(ocrWords, apiKey, fromLang, toLang)

    // Merge OCR positions with translations
    const merged = ocrWords.map((w) => {
      const t = translations.find((tr) => tr.i === w.i)
      return {
        ...w,
        translation: t?.t || '',
        synonyms: t?.s || [],
        category: t?.c || 'foreign',
        partOfSpeech: t?.p || 'other',
        pronunciation: t?.r || '',
      }
    })

    console.log('[Overlay] Merged', merged.length, 'words, translated:', merged.filter(w => w.translation).length)
    renderWords(merged)
  } catch (err) {
    console.error('[Overlay] Processing failed:', err)
    showStatus('Error: ' + err.message)
  }
}

// ─── IPC Listeners ──────────────────────────────────────────────────────────
if (window.overlayAPI) {
  window.overlayAPI.onCapture((dataUrl) => {
    console.log('[Overlay] Received screenshot, length:', dataUrl.length)
    processScreenshot(dataUrl)
  })

  window.overlayAPI.onDismiss(() => {
    console.log('[Overlay] Dismissed')
    clearOverlay()
  })

  // ESC key as backup
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearOverlay()
      window.overlayAPI.dismiss()
    }
  })
}

console.log('[Overlay] Script loaded. Screen:', window.innerWidth, 'x', window.innerHeight)
