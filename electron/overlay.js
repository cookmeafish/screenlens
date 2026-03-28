// ScreenLens Overlay — transparent screen translation overlay
// Connects to Vite dev server at localhost:3000 for API access

const VITE_URL = 'http://localhost:3000'
const root = document.getElementById('overlay-root')

let currentTooltip = null
let statusEl = null

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
  showStatus('Translating...', true)

  const context = words.map((w) => w.text).join(' ')
  const input = JSON.stringify({
    words: words.map((w) => ({ i: w.i, w: w.text })),
    from: fromLang || 'Spanish',
    to: toLang || 'English',
    context,
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
  showStatus(`${words.length} words translated. Hover to see translations. ESC to close.`)

  const posColors = {
    noun: { bg: 'rgba(88,166,255,.15)', border: 'rgba(88,166,255,.3)', text: '#58a6ff' },
    verb: { bg: 'rgba(210,168,255,.15)', border: 'rgba(210,168,255,.3)', text: '#d2a8ff' },
    adj: { bg: 'rgba(255,166,87,.15)', border: 'rgba(255,166,87,.3)', text: '#ffa657' },
  }

  words.forEach((word) => {
    if (!word.translation || word.category === 'target' || word.category === 'number') return

    const colors = posColors[word.partOfSpeech] || posColors.noun
    const box = document.createElement('div')
    box.className = 'word-box'
    box.style.left = word.bbox.x0 + 'px'
    box.style.top = word.bbox.y0 + 'px'
    box.style.width = (word.bbox.x1 - word.bbox.x0) + 'px'
    box.style.height = (word.bbox.y1 - word.bbox.y0) + 'px'
    box.style.background = colors.bg
    box.style.borderColor = colors.border

    box.addEventListener('mouseenter', () => showTooltip(word, box))
    box.addEventListener('mouseleave', () => hideTooltip())

    root.appendChild(box)
  })
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
  tt.style.left = Math.max(10, rect.left) + 'px'
  tt.style.top = Math.max(10, rect.top - 10) + 'px'
  tt.style.transform = 'translateY(-100%)'

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

    renderWords(merged)
  } catch (err) {
    console.error('[Overlay] Processing failed:', err)
    showStatus('Error: ' + err.message)
  }
}

// ─── IPC Listeners ──────────────────────────────────────────────────────────
if (window.overlayAPI) {
  window.overlayAPI.onCapture((dataUrl) => {
    console.log('[Overlay] Received screenshot')
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

console.log('[Overlay] Script loaded, waiting for capture...')
