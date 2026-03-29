import { useState, useRef, useCallback, useEffect } from 'react'
import Tesseract from 'tesseract.js'
import { TRANSLATE_PROMPT, POS_COLORS, CATEGORY_COLORS } from './config/prompts'
import { PROVIDERS } from './config/providers'
import { LANGS } from './config/languages'
import FormattedText from './components/FormattedText'
import { S } from './styles/theme'
import { ocrLog, ocrLogTable, ocrLogFlush } from './utils/logger'
import { ankiPing, ankiGetDecks, ankiCreateDeck, ankiAddNote, ankiFindCards, ankiCardsInfo, ankiAnswerCards, ankiGetDeckStats, ankiFindNotes, ankiNotesInfo, ankiUpdateNote, ankiDeleteNotes, ankiSync } from './utils/anki'


// ─── Image Preprocessing for OCR ────────────────────────────────────────────
async function preprocessForOCR(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)

      const imageData = ctx.getImageData(0, 0, c.width, c.height)
      const d = imageData.data

      // Step 1: Convert to grayscale
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = d[i + 1] = d[i + 2] = gray
      }

      // Step 2: Detect if background is dark
      let totalBrightness = 0
      const pixelCount = d.length / 4
      for (let i = 0; i < d.length; i += 4) totalBrightness += d[i]
      const avgBrightness = totalBrightness / pixelCount
      const isDark = avgBrightness < 128

      // Step 3: Contrast enhancement
      const factor = isDark ? 1.8 : 1.4
      for (let i = 0; i < d.length; i += 4) {
        const val = (d[i] - 128) * factor + 128
        d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, val))
      }

      // Step 4: Adaptive thresholding
      const w = c.width, h = c.height
      const gray = new Uint8Array(pixelCount)
      for (let i = 0; i < pixelCount; i++) gray[i] = d[i * 4]

      const blockSize = Math.max(15, Math.round(Math.min(w, h) / 50) | 1)
      const half = blockSize >> 1
      const threshold = new Uint8Array(pixelCount)

      // Build integral image for fast local averages
      const integral = new Float64Array((w + 1) * (h + 1))
      for (let y = 0; y < h; y++) {
        let rowSum = 0
        for (let x = 0; x < w; x++) {
          rowSum += gray[y * w + x]
          integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)]
        }
      }

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - half), y0 = Math.max(0, y - half)
          const x1 = Math.min(w - 1, x + half), y1 = Math.min(h - 1, y + half)
          const count = (x1 - x0 + 1) * (y1 - y0 + 1)
          const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
            - integral[y0 * (w + 1) + (x1 + 1)]
            - integral[(y1 + 1) * (w + 1) + x0]
            + integral[y0 * (w + 1) + x0]
          const localMean = sum / count
          const offset = isDark ? -15 : 15
          threshold[y * w + x] = gray[y * w + x] > localMean - offset ? 255 : 0
        }
      }

      // If dark background, invert so text is dark on white (Tesseract prefers this)
      for (let i = 0; i < pixelCount; i++) {
        const val = isDark ? (255 - threshold[i]) : threshold[i]
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = val
      }

      ctx.putImageData(imageData, 0, 0)
      resolve(c.toDataURL('image/png'))
    }
    img.src = dataUrl
  })
}

export default function App() {
  // ─── State ───────────────────────────────────────────────────────────────────
  const isOverlay = new URLSearchParams(window.location.search).has('overlay')
  const [provider, setProvider] = useState('anthropic')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [apiKeys, setApiKeys] = useState({})
  const [keysLoaded, setKeysLoaded] = useState(false)
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [screenshot, setScreenshot] = useState(null)
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 })
  const [ocrWords, setOcrWords] = useState([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState(null)
  const [hoveredIdx, setHoveredIdx] = useState(null)
  const [pinnedIdx, setPinnedIdx] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [explanation, setExplanation] = useState(null)
  const [explaining, setExplaining] = useState(false)
  const [deepExplanation, setDeepExplanation] = useState(null)
  const [deepExplaining, setDeepExplaining] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([]) // [{ role, text }]
  const [chatLoading, setChatLoading] = useState(false)
  const [wordStudy, setWordStudy] = useState(null)
  const [wordStudyLoading, setWordStudyLoading] = useState(false)
  const [conjugation, setConjugation] = useState(null)
  const [conjugationLoading, setConjugationLoading] = useState(false)
  const [stage, setStage] = useState('idle') // idle | captured | ocr | translating | done
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [showHighlights, setShowHighlights] = useState(true)
  const [language, setLanguage] = useState('auto')
  const [targetLang, setTargetLang] = useState('eng')
  const [overlayRunning, setOverlayRunning] = useState(false)
  const [ankiConnected, setAnkiConnected] = useState(null)
  const [ankiDecks, setAnkiDecks] = useState([])
  const [ankiCard, setAnkiCard] = useState(null)
  const [ankiSynced, setAnkiSynced] = useState({})
  const [ankiSyncing, setAnkiSyncing] = useState(false)
  const [ankiError, setAnkiError] = useState(null)
  const [ankiGenerating, setAnkiGenerating] = useState(false)
  const [showAnkiSettings, setShowAnkiSettings] = useState(false)
  const defaultStudyRules = {
    questionsPerCard: 3,
    cardsAtOnce: 3,
    studyLanguage: 'English',
    grammarFeedback: false,
    questionPrompt: 'You are quizzing a language learner on a flashcard.\n\nGenerate clear, specific questions that test whether the student truly knows this word/phrase. Mix question types:\n- Meaning and translation questions\n- Usage in context (give a scenario, ask them to fill in the word)\n- Synonyms, antonyms, or related words\n- Grammar questions (part of speech, conjugation, gender)\n\nRULES:\n- Questions must be precise and have ONE clear correct answer based on the card content\n- Never ask "what is the primary purpose" or "what is the main reason" — these are ambiguous\n- Never ask questions where multiple answers from the card could be valid\n- Each question must stand on its own — do not reference other questions\n- If the card has a list of points, ask about specific items, not "what is the primary one"',
    ratingRules: 'All correct = Easy, 1 wrong = AI judges Good or Hard based on answer quality, 2 wrong = Hard, All wrong = Again',
  }
  const defaultGeneralStudyRules = {
    questionsPerCard: 3,
    cardsAtOnce: 3,
    studyLanguage: 'English',
    grammarFeedback: false,
    questionPrompt: 'You are quizzing a student on a flashcard for their studies.\n\nGenerate clear, specific questions that test understanding of this concept. Mix question types:\n- Definition and explanation questions\n- Real-world application or scenario questions\n- Compare/contrast with related concepts\n- Why it matters or when you would use it\n\nRULES:\n- Questions must be precise and have ONE clear correct answer based on the card content\n- Never ask "what is the primary purpose" or "what is the main reason" — these are ambiguous\n- Never ask questions where multiple answers from the card could be valid\n- Each question must stand on its own — do not reference other questions\n- If the card has a list of points, ask about specific items, not "what is the primary one"\n- Questions should be answerable in 1-2 sentences',
    ratingRules: 'All correct = Easy, 1 wrong = AI judges Good or Hard based on answer quality, 2 wrong = Hard, All wrong = Again',
  }
  const defaultMode = {
    id: 1, name: 'Language Learning', type: 'language', description: '', ankiDeck: '',
    fields: { pronunciation: true, translation: true, synonyms: true, definition: true, example: true },
    frontTemplate: '{word} ({partOfSpeech})',
    backTemplate: 'Pronunciación: {pronunciation}\nTraducción: {translation}\nSinónimos: {synonyms}\nDefinición: {definition}\nEjemplo: {example}',
    tagRules: 'Always include:\n- part of speech (e.g. verb, noun, adjective)\n- source language (e.g. spanish, french)\n- "screenlens"\n\nAlso include when relevant:\n- verb tense (e.g. present, past, subjunctive)\n- difficulty (e.g. common, intermediate, advanced)\n- topic (e.g. food, emotion, travel, nature)',
    studyRules: defaultStudyRules,
  }
  const [modes, setModes] = useState([defaultMode])
  const [activeModeId, setActiveModeId] = useState(1)
  const [showModePanel, setShowModePanel] = useState(false)
  const [showModeFormatEditor, setShowModeFormatEditor] = useState(false)
  const [editingModeName, setEditingModeName] = useState(null)
  const [modeCreating, setModeCreating] = useState(false)
  const [modeEditInput, setModeEditInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showAnkiSection, setShowAnkiSection] = useState(false)
  const [showKnowledgeSection, setShowKnowledgeSection] = useState(false)
  const [settingsSection, setSettingsSection] = useState(null) // null | 'format' | 'tags' | 'study' (sub-sections within Anki)

  const [studyActive, setStudyActive] = useState(false)
  const [studyAllCards, setStudyAllCards] = useState([])     // all cards to study
  const [studyBatchIdx, setStudyBatchIdx] = useState(0)      // which batch we're on
  // Per-card tracking: { cardId, front, back, questions: [], answers: [], results: [], done: false }
  const [studyCardState, setStudyCardState] = useState([])
  // Queue of { cardIdx, questionIdx } to ask, interleaved
  const [studyQueue, setStudyQueue] = useState([])
  const [studyQueueIdx, setStudyQueueIdx] = useState(0)
  const [studyPhase, setStudyPhase] = useState('pick')       // 'pick' | 'question' | 'batchFeedback' | 'summary'
  const [studyDeck, setStudyDeck] = useState('')
  const [studyInput, setStudyInput] = useState('')
  const [studyLoading, setStudyLoading] = useState(false)
  const [studyStats, setStudyStats] = useState({ easy: 0, good: 0, hard: 0, again: 0 })
  const [studyDeckStats, setStudyDeckStats] = useState({ new_count: 0, learn_count: 0, review_count: 0 })
  const [studyKnowledge, setStudyKnowledge] = useState(null)
  const [studyKnowledgeCount, setStudyKnowledgeCount] = useState(0)
  const [knowledgeFiles, setKnowledgeFiles] = useState([])
  const [knowledgeDragging, setKnowledgeDragging] = useState(false)

  // Deck browser
  const [deckBrowserActive, setDeckBrowserActive] = useState(false)
  const [deckBrowserDeck, setDeckBrowserDeck] = useState('')
  const [deckBrowserNotes, setDeckBrowserNotes] = useState([])
  const [deckBrowserLoading, setDeckBrowserLoading] = useState(false)
  const [deckBrowserEditing, setDeckBrowserEditing] = useState(null) // noteId being edited
  const [deckBrowserEditFields, setDeckBrowserEditFields] = useState({})
  const [deckBrowserSearch, setDeckBrowserSearch] = useState('')

  const activeMode = modes.find((m) => m.id === activeModeId) || modes[0] || defaultMode
  const ankiFormat = activeMode
  const ankiDeck = activeMode.ankiDeck || ''
  const setAnkiDeck = (deck) => {
    const updated = modes.map((m) => m.id === activeModeId ? { ...m, ankiDeck: deck } : m)
    setModes(updated)
    // Save immediately
    fetch('/api/modes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modes: updated, activeModeId }),
    }).catch(() => {})
  }

  const fileInputRef = useRef(null)
  const containerRef = useRef(null)

  const apiKey = apiKeys[provider] || ''
  const providerConfig = PROVIDERS[provider]

  // ─── Load Keys & Config from file on mount ─────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch('/api/keys').then((r) => r.json()).catch(() => ({})),
      fetch('/api/config').then((r) => r.json()).catch(() => ({})),
      fetch('/api/modes').then((r) => r.json()).catch(() => null),
      fetch('/api/ankiformat').then((r) => r.json()).catch(() => null),
    ]).then(([keys, config, modesData, legacyFormat]) => {
      // Load modes from /api/modes (per-file storage)
      if (modesData && modesData.modes && modesData.modes.length > 0) {
        setModes(modesData.modes)
        if (modesData.activeModeId) setActiveModeId(modesData.activeModeId)
      } else if (legacyFormat) {
        // Migrate from legacy ankiformat.json
        let migrated = null
        if (legacyFormat.modes) {
          migrated = legacyFormat.modes
          if (legacyFormat.activeModeId) setActiveModeId(legacyFormat.activeModeId)
        } else if (legacyFormat.profiles) {
          migrated = legacyFormat.profiles.map((p) => ({
            ...p, type: 'language', description: '', tagRules: defaultMode.tagRules,
          }))
          if (legacyFormat.activeProfileId) setActiveModeId(legacyFormat.activeProfileId)
        } else if (legacyFormat.fields) {
          migrated = [{ ...defaultMode, ...legacyFormat, id: 1, name: 'Language Learning', type: 'language' }]
        }
        if (migrated) {
          setModes(migrated)
          // Save to new format
          fetch('/api/modes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modes: migrated, activeModeId: migrated[0]?.id || 1 }),
          }).catch(() => {})
          console.log('[Mode] migrated from legacy ankiformat.json')
        }
      }
      setApiKeys(keys)
      if (config.provider) setProvider(config.provider)
      if (config.language) setLanguage(config.language)
      if (config.targetLang) setTargetLang(config.targetLang)
      if (config.showHighlights !== undefined) setShowHighlights(config.showHighlights)
      // ankiDeck is now per-mode (stored in mode config)
      setKeysLoaded(true)
      setConfigLoaded(true)
    })
    // Poll overlay status
    const overlayPoll = setInterval(() => {
      fetch('/api/launch-overlay').then(r => r.json()).then(d => setOverlayRunning(d.running)).catch(() => {})
    }, 3000)

    // Overlay mode: listen for screenshot capture events from Electron
    const handleOverlayCapture = async () => {
      const url = window.__overlayScreenshot
      if (!url) return
      console.log('[Overlay] Loading screenshot from:', url)
      try {
        const resp = await fetch(url)
        const blob = await resp.blob()
        const reader = new FileReader()
        reader.onload = (e) => {
          const dataUrl = e.target.result
          // Load image and auto-start analysis
          const img = new Image()
          img.onload = () => {
            setImgDims({ w: img.naturalWidth, h: img.naturalHeight })
            setScreenshot(dataUrl)
            setStage('captured')
            setOcrWords([])
            setError(null)
            // Auto-analyze after state update
            setTimeout(() => window.__autoAnalyze = dataUrl, 100)
          }
          img.src = dataUrl
        }
        reader.readAsDataURL(blob)
      } catch (err) {
        console.error('[Overlay] Failed to load screenshot:', err)
      }
    }
    window.addEventListener('overlay-capture', handleOverlayCapture)

    // Check AnkiConnect on mount
    console.log('[Anki] checking connection on mount...')
    ankiPing().then((ok) => {
      setAnkiConnected(ok)
      console.log('[Anki] mount check:', ok ? 'connected' : 'not connected')
      if (ok) ankiGetDecks().then((decks) => {
        setAnkiDecks(decks)
        console.log('[Anki] available decks:', decks)
        // If active mode has no deck or deck doesn't exist, default to first available
        setModes((prev) => {
          const updated = prev.map((m) => {
            if (!m.ankiDeck || (decks.length > 0 && !decks.includes(m.ankiDeck))) {
              return { ...m, ankiDeck: decks[0] || '' }
            }
            return m
          })
          return updated
        })
      }).catch(() => {})
    })
  }, [])

  // ─── Save Keys to .env on change ──────────────────────────────────────────
  useEffect(() => {
    if (!keysLoaded) return
    fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiKeys),
    }).catch(() => {})
  }, [apiKeys, keysLoaded])

  // ─── Save Config on change ────────────────────────────────────────────────
  useEffect(() => {
    if (!configLoaded) return
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, language, targetLang, showHighlights }),
    }).catch(() => {})
  }, [provider, language, targetLang, showHighlights, configLoaded])

  const setCurrentKey = (key) => {
    setApiKeys((prev) => ({ ...prev, [provider]: key }))
    if (key) setError(null)
  }

  // Show key input if none stored for current provider
  useEffect(() => {
    if (keysLoaded && !apiKeys[provider]) setShowKeyInput(true)
  }, [provider, keysLoaded])

  // ─── Load Image Helper ──────────────────────────────────────────────────────
  const loadImageFromDataUrl = useCallback((dataUrl) => {
    const img = new Image()
    img.onload = () => {
      setImgDims({ w: img.naturalWidth, h: img.naturalHeight })
      setScreenshot(dataUrl)
      setStage('captured')
      setOcrWords([])
      setExpanded(false)
      setError(null)
    }
    img.src = dataUrl
  }, [])

  const loadImageFromFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => loadImageFromDataUrl(e.target.result)
    reader.readAsDataURL(file)
  }, [loadImageFromDataUrl])

  // ─── Screen Capture ─────────────────────────────────────────────────────────
  const captureScreen = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { mediaSource: 'screen' },
      })

      const video = document.createElement('video')
      video.srcObject = stream
      await video.play()

      // Wait for a solid frame
      await new Promise((r) => setTimeout(r, 150))

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)

      // Stop all tracks immediately
      stream.getTracks().forEach((t) => t.stop())
      video.remove()

      const dataUrl = canvas.toDataURL('image/png')
      loadImageFromDataUrl(dataUrl)
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError('Screen capture failed: ' + err.message)
      }
    }
  }, [loadImageFromDataUrl])

  // ─── Analysis Pipeline ──────────────────────────────────────────────────────
  const analyzeImage = useCallback(async (dataUrl) => {
    if (!dataUrl) return
    if (!apiKey) {
      setShowKeyInput(true)
      setError(`Set your ${providerConfig.label} API key first.`)
      return
    }

    setLoading(true)
    setStage('ocr')
    setError(null)
    setOcrWords([])

    try {
      // ── Stage 1: Tesseract OCR ──────────────────────────────────────────────
      setProgress('Initializing OCR engine…')

      // Get real image dimensions (don't rely on imgDims state which can be stale)
      const dimImg = new Image()
      await new Promise((resolve) => { dimImg.onload = resolve; dimImg.src = dataUrl })
      const realW = dimImg.naturalWidth, realH = dimImg.naturalHeight

      // Downscale for OCR if wider than 1920px (speeds up Tesseract, display stays full-res)
      let ocrInput = dataUrl
      if (realW > 1920) {
        const scale = 1920 / realW
        const c = document.createElement('canvas')
        c.width = 1920
        c.height = Math.round(realH * scale)
        const ctx = c.getContext('2d')
        const img = new Image()
        await new Promise((resolve) => { img.onload = resolve; img.src = dataUrl })
        ctx.drawImage(img, 0, 0, c.width, c.height)
        ocrInput = c.toDataURL('image/png')
      }

      // Preprocess image for better OCR accuracy (grayscale, contrast, threshold)
      setProgress('Preprocessing image…')
      ocrInput = await preprocessForOCR(ocrInput)

      const ocrLang = language === 'auto' ? 'eng+spa+fra+deu+por+ita' : language
      const result = await Tesseract.recognize(ocrInput, ocrLang, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            setProgress(`OCR: ${Math.round((m.progress || 0) * 100)}%`)
          } else if (m.status) {
            setProgress(m.status)
          }
        },
      })

      // Scale bounding boxes back to original resolution if we downscaled
      const bboxScale = realW > 1920 ? realW / 1920 : 1

      // ── Log: Raw Tesseract output ──
      const allTessWords = (result.data.words || [])
      ocrLog(`Image: ${realW}x${realH}, bboxScale=${bboxScale.toFixed(2)}`)
      ocrLog(`Tesseract returned ${allTessWords.length} raw words`)
      ocrLogTable('Raw Tesseract words', allTessWords.map((w) => ({
        text: w.text.trim(),
        conf: Math.round(w.confidence),
        x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
        w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0,
      })))

      const rawWords = allTessWords
        .filter((w) => {
          const t = w.text.trim()
          if (t.length === 0) return false
          if (!/[a-zA-ZÀ-ÿ]/.test(t)) return false
          // Clean text first (strip leading/trailing non-letters) — use cleaned length for thresholds
          const cleaned = t.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '') || t
          const letterCount = (cleaned.match(/[a-zA-ZÀ-ÿ]/g) || []).length
          if (letterCount < 2) {
            if (letterCount === 1 && w.confidence >= 85) return true
            return false
          }
          const minConf = cleaned.length <= 2 ? 70 : cleaned.length <= 3 ? 55 : 50
          if (w.confidence < minConf) {
            ocrLog(`[FILTERED conf] "${cleaned}" conf=${Math.round(w.confidence)} < ${minConf}`)
            return false
          }
          const bw = w.bbox.x1 - w.bbox.x0, bh = w.bbox.y1 - w.bbox.y0
          if (bw > 0 && bh > 0 && (bw / bh > 15 || bh / bw > 5)) {
            ocrLog(`[FILTERED shape] "${cleaned}" aspect=${(bw/bh).toFixed(1)} (${bw}x${bh})`)
            return false
          }
          if (bw < 10 || bh < 10) {
            ocrLog(`[FILTERED tiny] "${cleaned}" (${bw}x${bh})`)
            return false
          }
          // Reject oversized bboxes (UI banners, not individual words)
          const scaledBw = bw * bboxScale, scaledBh = bh * bboxScale
          if (scaledBw * scaledBh > realW * realH * 0.05) {
            ocrLog(`[FILTERED huge] "${cleaned}" covers ${((scaledBw*scaledBh)/(realW*realH)*100).toFixed(1)}% of image`)
            return false
          }
          if (scaledBw > realW * 0.4) {
            ocrLog(`[FILTERED wide] "${cleaned}" width=${Math.round(scaledBw)} > 40% of image`)
            return false
          }
          return true
        })
        .map((w) => ({
          text: w.text.trim().replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '') || w.text.trim(),
          bbox: {
            x0: Math.round(w.bbox.x0 * bboxScale),
            y0: Math.round(w.bbox.y0 * bboxScale),
            x1: Math.round(w.bbox.x1 * bboxScale),
            y1: Math.round(w.bbox.y1 * bboxScale),
          },
          confidence: w.confidence,
        }))

      ocrLogTable(`After filtering: ${rawWords.length} words`, rawWords.map((w) => ({ text: w.text, conf: Math.round(w.confidence), ...w.bbox })))

      // Deduplicate overlapping bounding boxes (Tesseract can detect the same
      // text region multiple times). Keep the higher-confidence read.
      const deduped = []
      for (const w of rawWords) {
        const area = (w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0)
        let dominated = false
        for (let k = deduped.length - 1; k >= 0; k--) {
          const d = deduped[k]
          const ix0 = Math.max(w.bbox.x0, d.bbox.x0)
          const iy0 = Math.max(w.bbox.y0, d.bbox.y0)
          const ix1 = Math.min(w.bbox.x1, d.bbox.x1)
          const iy1 = Math.min(w.bbox.y1, d.bbox.y1)
          if (ix0 >= ix1 || iy0 >= iy1) continue
          const inter = (ix1 - ix0) * (iy1 - iy0)
          const dArea = (d.bbox.x1 - d.bbox.x0) * (d.bbox.y1 - d.bbox.y0)
          // Use IoU (intersection-over-union) so large bad bboxes don't eat valid words
          const iou = inter / (area + dArea - inter)
          if (iou > 0.4) {
            if (w.confidence > d.confidence) {
              ocrLog(`[DEDUP] "${d.text}" (${Math.round(d.confidence)}%) replaced by "${w.text}" (${Math.round(w.confidence)}%) IoU=${(iou*100).toFixed(0)}%`)
              deduped.splice(k, 1)
            } else {
              ocrLog(`[DEDUP] "${w.text}" (${Math.round(w.confidence)}%) dropped, kept "${d.text}" (${Math.round(d.confidence)}%) IoU=${(iou*100).toFixed(0)}%`)
              dominated = true
              break
            }
          }
        }
        if (!dominated) deduped.push(w)
      }

      // Sort in reading order (top-to-bottom, left-to-right) so the AI receives
      // consecutive fragments as consecutive indices for "m" merge detection
      deduped.sort((a, b) => {
        const avgH = ((a.bbox.y1 - a.bbox.y0) + (b.bbox.y1 - b.bbox.y0)) / 2
        if (Math.abs(a.bbox.y0 - b.bbox.y0) < avgH * 0.5) return a.bbox.x0 - b.bbox.x0
        return a.bbox.y0 - b.bbox.y0
      })

      ocrLogTable(`After dedup + sort: ${deduped.length} words (final)`, deduped.map((w) => ({ text: w.text, conf: Math.round(w.confidence), ...w.bbox })))

      const finalWords = deduped

      if (finalWords.length === 0) {
        setError('No readable text found. Try a different language or a clearer screenshot.')
        setStage('captured')
        setLoading(false)
        return
      }

      // ── Stage 2: AI Translation ────────────────────────────────────────────
      setStage('translating')
      setProgress(`Found ${finalWords.length} words. Translating…`)

      const wordTexts = finalWords.map((w) => w.text)
      const fullContext = wordTexts.join(' ')
      const chunkSize = 80
      const allTranslations = {} // globalIndex → { t, s, e }

      for (let i = 0; i < wordTexts.length; i += chunkSize) {
        const chunk = wordTexts.slice(i, i + chunkSize)
        const chunkEnd = Math.min(i + chunkSize, wordTexts.length)
        setProgress(`Translating ${i + 1}–${chunkEnd} of ${wordTexts.length}…`)

        // Build array of {i, w} objects with global indices
        const indexedWords = chunk.map((word, j) => ({ i: i + j, w: word }))

        const fromLabel = language === 'auto' ? 'Auto-detect' : (LANGS.find((l) => l.code === language)?.label || 'Unknown')
        const toLabel = LANGS.find((l) => l.code === targetLang)?.label || 'English'
        const payload = JSON.stringify({ words: indexedWords, from: fromLabel, to: toLabel, context: fullContext })
        const text = await providerConfig.call(apiKey, TRANSLATE_PROMPT, payload)
        if (!text) throw new Error('Empty translation response')

        ocrLog(`Chunk ${i}: sent ${indexedWords.length} words`)
        ocrLog(`AI returned: ${text.slice(0, 300)}`)

        // Extract JSON from response — handle markdown wrapping, preamble, etc.
        let cleaned = text
        // Strip markdown code fences
        cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '')
        // Try to find the JSON array/object in the response
        const jsonStart = cleaned.indexOf('[') !== -1 ? cleaned.indexOf('[') : cleaned.indexOf('{')
        if (jsonStart > 0) cleaned = cleaned.slice(jsonStart)
        const lastBracket = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'))
        if (lastBracket > 0) cleaned = cleaned.slice(0, lastBracket + 1)
        cleaned = cleaned.trim()

        let parsed
        try {
          parsed = JSON.parse(cleaned)
        } catch {
          let r = cleaned
          // Fix unquoted or single-quoted property names
          r = r.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
          r = r.replace(/'/g, '"')
          r = r.replace(/,\s*([}\]])/g, '$1')
          if ((r.match(/"/g) || []).length % 2 !== 0) r += '"'
          r = r.replace(/,\s*$/, '')
          let ob = (r.match(/\[/g) || []).length - (r.match(/\]/g) || []).length
          let oc = (r.match(/\{/g) || []).length - (r.match(/\}/g) || []).length
          for (; ob > 0; ob--) r += ']'
          for (; oc > 0; oc--) r += '}'
          try {
            parsed = JSON.parse(r)
          } catch (e2) {
            ocrLog(`[ERROR] JSON repair failed: ${e2.message}\nRaw: ${text.slice(0, 500)}`)
            // Last resort: skip this chunk, words will be retried via lazy translate
            continue
          }
        }

        // Flatten to array of items (handles both array and object responses)
        let items = []
        if (Array.isArray(parsed)) {
          items = parsed
        } else if (parsed && typeof parsed === 'object') {
          items = Object.values(parsed)
        }

        // Match each item to its word using the embedded "i" index
        // Build a lookup of original words for fallback matching by "w"
        const wordLookup = {}
        indexedWords.forEach((iw) => {
          if (!wordLookup[iw.w]) wordLookup[iw.w] = []
          wordLookup[iw.w].push(iw.i)
        })
        const usedByW = new Set()

        for (const item of items) {
          if (!item || typeof item !== 'object') continue

          // Primary match: by "i" field
          if (item.i !== undefined && item.i !== null) {
            const idx = Number(item.i)
            if (!isNaN(idx) && idx >= i && idx < chunkEnd) {
              allTranslations[String(idx)] = item
              continue
            }
          }

          // Fallback match: by "w" field (original word)
          if (item.w && wordLookup[item.w]) {
            const candidates = wordLookup[item.w].filter((ci) => !usedByW.has(ci) && !allTranslations[String(ci)])
            if (candidates.length > 0) {
              const idx = candidates[0]
              usedByW.add(idx)
              allTranslations[String(idx)] = item
            }
          }
        }
      }

      // ── AI-driven fragment merge ─────────────────────────────────────────
      // The AI detects OCR fragments via "m" field (e.g. "Sob"+"reguardia" → "Sobreguardia")
      // Only merge if words are spatially adjacent (same row, close horizontally)
      const mergedAway = new Set() // indices to hide (absorbed into another word)
      for (const [, item] of Object.entries(allTranslations)) {
        if (item.m && Array.isArray(item.m) && item.m.length > 1) {
          const indices = item.m.filter((idx) => idx >= 0 && idx < finalWords.length)
          if (indices.length < 2) continue
          indices.sort((a, b) => a - b)
          // Verify spatial adjacency — all words must be on the same row and close together
          let spatiallyValid = true
          for (let k = 1; k < indices.length; k++) {
            const prev = finalWords[indices[k - 1]].bbox
            const curr = finalWords[indices[k]].bbox
            const avgH = ((prev.y1 - prev.y0) + (curr.y1 - curr.y0)) / 2
            const sameRow = Math.abs(prev.y0 - curr.y0) < avgH * 0.6
            const gap = curr.x0 - prev.x1
            const closeEnough = gap < avgH * 2 // within 2x char height
            if (!sameRow || !closeEnough) {
              ocrLog(`[AI MERGE REJECTED] "${finalWords[indices[k-1]].text}" + "${finalWords[indices[k]].text}" not spatially adjacent (sameRow=${sameRow}, gap=${gap})`)
              spatiallyValid = false
              break
            }
          }
          if (!spatiallyValid) continue
          const first = indices[0]
          const mergedText = indices.map((idx) => finalWords[idx].text).join('')
          const mergedBbox = {
            x0: Math.min(...indices.map((idx) => finalWords[idx].bbox.x0)),
            y0: Math.min(...indices.map((idx) => finalWords[idx].bbox.y0)),
            x1: Math.max(...indices.map((idx) => finalWords[idx].bbox.x1)),
            y1: Math.max(...indices.map((idx) => finalWords[idx].bbox.y1)),
          }
          ocrLog(`[AI MERGE] ${indices.map((i) => `"${finalWords[i].text}"`).join(' + ')} → "${mergedText}" (translation: "${item.t}")`)
          finalWords[first] = { ...finalWords[first], text: mergedText, bbox: mergedBbox }
          for (let k = 1; k < indices.length; k++) {
            mergedAway.add(indices[k])
          }
        }
      }
      if (mergedAway.size > 0) {
        ocrLog(`Merged away ${mergedAway.size} fragment(s): indices ${[...mergedAway].join(', ')}`)
      }

      // ── Quick gap check: fill any missing indices ──────────────────────────
      const missing = []
      for (let i = 0; i < finalWords.length; i++) {
        if (!allTranslations[String(i)]) {
          allTranslations[String(i)] = { t: 'Loading…', s: [], e: false, _untranslated: true }
          missing.push(i)
        }
      }
      if (missing.length > 0) {
        ocrLog(`${missing.length} words had no translation, will translate on hover: ${missing.map((i) => finalWords[i].text).join(', ')}`)
      }

      // ── Merge OCR + Translation (matched by index) ─────────────────────────
      // Skip fragments that were merged into another word by the AI
      const translatedWords = finalWords
        .map((w, i) => {
          if (mergedAway.has(i)) return null // absorbed into another word
          const t = allTranslations[String(i)]
          const category = t.c || (t.e === true ? 'target' : 'foreign')
          const partOfSpeech = t.p || 'other'
          return {
            text: w.text,
            bbox: w.bbox,
            confidence: w.confidence,
            translation: t.t || w.text,
            synonyms: t.s || [],
            category,
            partOfSpeech,
            pronunciation: t.r || '',
            isEnglish: category === 'target',
            _untranslated: t._untranslated || false,
          }
        })
        .filter(Boolean)

      ocrLog(`Pipeline complete: ${translatedWords.length} words`)
      ocrLogFlush() // Write logs to logs/ directory

      setOcrWords(translatedWords)
      setStage('done')

      // Auto-retry any missed words in background
      if (missing.length > 0) {
        missing.forEach((idx) => lazyTranslate(idx))
      }
    } catch (err) {
      ocrLog(`[ERROR] ${err.message}`)
      ocrLogFlush()
      console.error(err)
      setError('Analysis failed: ' + err.message)
      setStage('captured')
    } finally {
      setLoading(false)
      setProgress('')
    }
  }, [apiKey, language, targetLang, providerConfig])

  // ─── Keyboard Shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+Shift+S → Screen capture
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        captureScreen()
      }
      // Escape → Dismiss pin first, then close expanded view
      if (e.key === 'Escape') {
        if (pinnedIdx !== null) {
          dismissPin()
        } else {
          setExpanded(false)
          setHoveredIdx(null)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [captureScreen])

  // ─── Paste Handler ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Don't capture paste if typing in input
      if (e.target.tagName === 'INPUT') return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          loadImageFromFile(item.getAsFile())
          return
        }
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [loadImageFromFile])

  // ─── Overlay auto-analyze ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOverlay) return
    const interval = setInterval(() => {
      if (window.__autoAnalyze && stage === 'captured') {
        const dataUrl = window.__autoAnalyze
        window.__autoAnalyze = null
        analyzeImage(dataUrl)
      }
    }, 200)
    return () => clearInterval(interval)
  })

  // ─── Drag & Drop ───────────────────────────────────────────────────────────
  const handleDragOver = (e) => {
    e.preventDefault()
    // Don't show image drop overlay if dragging text files while knowledge section is open
    if (showKnowledgeSection) return
    setDragging(true)
  }
  const handleDragLeave = (e) => {
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget)) setDragging(false)
  }
  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    console.log('[App] drop event, file:', file.name, 'knowledgeOpen:', showKnowledgeSection)
    // Don't handle text files at app level — they're for knowledge base
    if (file.name.match(/\.(txt|md)$/i)) {
      // If knowledge section is open, forward the file there
      if (showKnowledgeSection) {
        console.log('[App] forwarding text file to knowledge upload')
        uploadKnowledgeFile(file)
      }
      return
    }
    loadImageFromFile(file)
  }

  // ─── Lazy translate on hover for missed words ──────────────────────────────
  const lazyTranslateRef = useRef(new Set()) // track in-flight requests
  const lazyTranslate = useCallback(async (idx) => {
    if (lazyTranslateRef.current.has(idx)) return
    lazyTranslateRef.current.add(idx)
    try {
      const word = ocrWords[idx]
      const context = ocrWords.map((w) => w.text).join(' ')
      const fromLabel = language === 'auto' ? 'Auto-detect' : (LANGS.find((l) => l.code === language)?.label || 'Unknown')
      const toLabel = LANGS.find((l) => l.code === targetLang)?.label || 'English'
      const payload = JSON.stringify({ words: [{ i: idx, w: word.text }], from: fromLabel, to: toLabel, context })
      const text = await providerConfig.call(apiKey, TRANSLATE_PROMPT, payload)
      if (!text) return
      let parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      // Get the first translation item regardless of format
      let t = null
      if (Array.isArray(parsed)) t = parsed[0]
      else if (parsed && typeof parsed === 'object') t = Object.values(parsed)[0]
      if (t) {
        setOcrWords((prev) => prev.map((w, i) => i === idx
          ? { ...w, translation: t.t || w.text, synonyms: t.s || [], isEnglish: t.e === true, _untranslated: false }
          : w
        ))
      }
    } catch (err) {
      console.warn('[ScreenLens] Lazy translate failed for index', idx, err)
    }
  }, [apiKey, language, ocrWords, providerConfig])

  // ─── Hover & Pin Handlers ───────────────────────────────────────────────────
  const handleWordHover = (idx, e) => {
    if (pinnedIdx !== null) return // don't override pinned tooltip
    setHoveredIdx(idx)
    const rect = e.currentTarget.getBoundingClientRect()
    // Smart positioning: avoid going off screen
    const vw = window.innerWidth, vh = window.innerHeight
    let x = rect.left + rect.width / 2
    let y = rect.top - 6
    let anchor = 'above' // default: tooltip above word
    // If word is near top, show tooltip below
    if (rect.top < 150) {
      y = rect.bottom + 6
      anchor = 'below'
    }
    // Clamp horizontal to keep tooltip on screen
    x = Math.max(160, Math.min(vw - 160, x))
    setTooltipPos({ x, y, anchor })
    if (ocrWords[idx]?._untranslated) lazyTranslate(idx)
  }

  const handleWordLeave = () => {
    if (pinnedIdx !== null) return
    setHoveredIdx(null)
  }

  const handleWordClick = (idx, e) => {
    e.stopPropagation()
    if (pinnedIdx === idx) {
      dismissPin()
    } else {
      // Pin this word
      setPinnedIdx(idx)
      setHoveredIdx(idx)
      setExplanation(null)
      setDeepExplanation(null)
      setWordStudy(null); setConjugation(null)
      setAnkiCard(null); setAnkiError(null)
      setChatMessages([])
      setChatInput('')
      const rect = e.currentTarget.getBoundingClientRect()
      setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top - 6 })
    }
  }

  const dismissPin = () => {
    setPinnedIdx(null)
    setExplanation(null)
    setDeepExplanation(null)
    setWordStudy(null); setConjugation(null)
    setAnkiCard(null); setAnkiError(null)
    setChatMessages([])
    setChatInput('')
    setHoveredIdx(null)
  }

  // ─── Explain Word (short, auto-triggered on pin) ───────────────────────────
  const getContext = () => ocrWords.map((w) => w.text).join(' ')

  const autoExplain = useCallback(async (word) => {
    if (!apiKey) return
    setExplaining(true)
    setExplanation(null)
    try {
      const prompt = activeMode.type === 'language'
        ? `Word: "${word.text}" (translated: "${word.translation}")
Context: "${getContext()}"

In 1-2 short sentences: what does "${word.text}" mean here and what part of speech is it? No markdown.`
        : `Term: "${word.text}"
Context: "${getContext()}"
Study subject: ${activeMode.description || activeMode.name}

In 1-2 short sentences: explain "${word.text}" in the context of ${activeMode.name}. No markdown.`
      const text = await providerConfig.call(apiKey, activeMode.type === 'language' ? 'You are a concise language tutor. Answer in 1-2 sentences max.' : `You are a concise ${activeMode.name} tutor. Answer in 1-2 sentences max.`, prompt)
      setExplanation(text)
    } catch (err) {
      setExplanation('Failed: ' + err.message)
    } finally {
      setExplaining(false)
    }
  }, [apiKey, ocrWords, providerConfig])

  // ─── Anki Connection & Card Sync ─────────────────────────────────────────
  const refreshAnkiConnection = async () => {
    console.log('[Anki] refreshing connection...')
    setAnkiConnected(null)
    const ok = await ankiPing()
    setAnkiConnected(ok)
    if (ok) {
      const decks = await ankiGetDecks().catch(() => [])
      setAnkiDecks(decks)
      console.log('[Anki] connected, decks:', decks)
      if (decks.length > 0 && !decks.includes(ankiDeck)) {
        console.log('[Anki] saved deck not found, defaulting to:', decks[0])
        setAnkiDeck(decks[0])
      }
    } else {
      console.log('[Anki] not connected')
    }
  }

  const generateAnkiCard = async (word) => {
    if (!apiKey || ankiGenerating) return
    setAnkiGenerating(true)
    setAnkiError(null)
    setAnkiCard(null)
    const srcLang = LANGS.find((l) => l.code === language)?.label || 'the source language'
    const tgtLang = LANGS.find((l) => l.code === targetLang)?.label || 'English'
    const context = ocrWords.map((w) => w.text).join(' ')
    const fmt = ankiFormat

    // Build the AI prompt based on which fields are enabled (dynamic)
    const fieldDescriptions = {
      pronunciation: `pronunciation guide in English phonetics (e.g. "KAH-lee-do"), include gender variants if applicable`,
      translation: `translation to ${tgtLang}`,
      synonyms: `comma-separated synonyms in ${tgtLang}, grouped by meaning if multiple`,
      definition: activeMode.type === 'language'
        ? `definition in ${srcLang} (the source language, not ${tgtLang})`
        : `clear, concise definition`,
      example: activeMode.type === 'language'
        ? `example sentence in ${srcLang} using the word in context, followed by (${tgtLang} translation in parentheses)`
        : `practical example or scenario illustrating this concept`,
    }
    const fieldRequests = []
    Object.entries(fmt.fields).forEach(([field, enabled]) => {
      if (!enabled) return
      const hint = fieldDescriptions[field] || `${field} - provide relevant content for this field`
      fieldRequests.push(`"${field}": ${hint}`)
    })
    // Add tag generation
    const tagInstruction = fmt.tagRules
      ? `"tags": array of tag strings. Rules:\n${fmt.tagRules}`
      : `"tags": array of relevant lowercase tags (include "screenlens")`
    fieldRequests.push(tagInstruction)

    const modeContext = activeMode.type === 'language'
      ? `Source language: ${srcLang}\nTranslation: ${word.translation}`
      : `Study subject: ${activeMode.description || activeMode.name}`

    const prompt = `Generate an Anki flashcard for the ${activeMode.type === 'language' ? 'word' : 'term'} "${word.text}" (${word.partOfSpeech || 'unknown'}).
${modeContext}
Context: "${context}"

Return a JSON object with these fields:
${fieldRequests.map((f) => `- ${f}`).join('\n')}

Output ONLY raw JSON. No markdown, no backticks.`

    try {
      console.log('[Anki] generating card with AI...')
      const text = await providerConfig.call(apiKey, 'You generate Anki flashcard content. Always respond with valid JSON only.', prompt)
      const cardData = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
      console.log('[Anki] AI card data:', cardData)

      // Dynamic template replacement
      const replacements = {
        word: word.text, term: word.text,
        partOfSpeech: word.partOfSpeech || '',
        ...cardData,
      }
      // Remove tags from replacements (it's an array, not a template field)
      const aiTags = cardData.tags
      delete replacements.tags

      let front = fmt.frontTemplate
      let back = fmt.backTemplate
      Object.entries(replacements).forEach(([key, val]) => {
        const re = new RegExp(`\\{${key}\\}`, 'g')
        front = front.replace(re, String(val || ''))
        back = back.replace(re, String(val || ''))
      })

      const tags = Array.isArray(aiTags) && aiTags.length > 0
        ? aiTags
        : ['screenlens']
      console.log('[Anki] card generated', { front, back, tags })
      setAnkiCard({ front, back, tags })
    } catch (err) {
      console.error('[Anki] card generation failed:', err.message)
      setAnkiError('Card generation failed: ' + err.message)
    } finally {
      setAnkiGenerating(false)
    }
  }

  const saveModes = (modeList, activeId) => {
    const id = activeId || activeModeId
    setModes(modeList)
    setActiveModeId(id)
    const payload = { modes: modeList, activeModeId: id }
    fetch('/api/modes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
    console.log('[Mode] saved', payload)
  }

  const updateActiveMode = (updates) => {
    const updated = modes.map((m) =>
      m.id === activeModeId ? { ...m, ...updates } : m
    )
    saveModes(updated)
  }

  const deleteMode = (id) => {
    if (modes.length <= 1) return
    const updated = modes.filter((m) => m.id !== id)
    const newActiveId = id === activeModeId ? updated[0].id : activeModeId
    saveModes(updated, newActiveId)
  }

  const renameMode = (id, newName) => {
    const trimmed = newName.trim()
    if (!trimmed) { setEditingModeName(null); return }
    // Check for name conflict
    const conflict = modes.find((m) => m.id !== id && m.name.toLowerCase() === trimmed.toLowerCase())
    if (conflict) {
      alert(`A mode named "${trimmed}" already exists.`)
      setEditingModeName(null)
      return
    }
    const updated = modes.map((m) =>
      m.id === id ? { ...m, name: trimmed } : m
    )
    saveModes(updated)
    setEditingModeName(null)
  }

  const addDefaultMode = () => {
    let name = 'Language Learning'
    let suffix = 0
    const existingNames = modes.map((m) => m.name.toLowerCase())
    while (existingNames.includes(name.toLowerCase())) {
      suffix++
      name = `Language Learning-${suffix}`
    }
    const newId = Math.max(0, ...modes.map((m) => m.id)) + 1
    const newMode = { ...defaultMode, id: newId, name }
    saveModes([...modes, newMode], newId)
  }

  // ─── Deck Browser ──────────────────────────────────────────────────────
  const openDeckBrowser = async () => {
    if (!ankiConnected) return
    const decks = await ankiGetDecks().catch(() => [])
    setAnkiDecks(decks)
    const deck = ankiDeck || decks[0] || ''
    setDeckBrowserDeck(deck)
    setDeckBrowserActive(true)
    setDeckBrowserNotes([])
    if (deck) loadDeckNotes(deck)
  }

  const loadDeckNotes = async (deck) => {
    setDeckBrowserLoading(true)
    setDeckBrowserEditing(null)
    try {
      const noteIds = await ankiFindNotes(`deck:"${deck}"`)
      const notes = noteIds.length > 0 ? await ankiNotesInfo(noteIds) : []
      setDeckBrowserNotes(notes)
      console.log('[Deck] loaded', notes.length, 'notes from:', deck)
    } catch (err) {
      console.error('[Deck] load failed:', err.message)
    } finally {
      setDeckBrowserLoading(false)
    }
  }

  const startEditNote = (note) => {
    const fields = {}
    // Convert HTML to plain text for editing (br → newline)
    Object.entries(note.fields).forEach(([name, f]) => {
      fields[name] = f.value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    })
    setDeckBrowserEditing(note.noteId)
    setDeckBrowserEditFields(fields)
  }

  const saveEditNote = async (noteId) => {
    // Convert newlines back to <br> for Anki
    const htmlFields = {}
    Object.entries(deckBrowserEditFields).forEach(([name, val]) => {
      htmlFields[name] = val.replace(/\n/g, '<br>')
    })
    try {
      await ankiUpdateNote(noteId, htmlFields)
      ankiSync().catch(() => {})
      // Reload
      await loadDeckNotes(deckBrowserDeck)
      setDeckBrowserEditing(null)
      console.log('[Deck] note updated:', noteId)
    } catch (err) {
      console.error('[Deck] update failed:', err.message)
    }
  }

  const deleteNote = async (noteId) => {
    try {
      await ankiDeleteNotes([noteId])
      ankiSync().catch(() => {})
      setDeckBrowserNotes((prev) => prev.filter((n) => n.noteId !== noteId))
      console.log('[Deck] note deleted:', noteId)
    } catch (err) {
      console.error('[Deck] delete failed:', err.message)
    }
  }

  const closeDeckBrowser = () => {
    setDeckBrowserActive(false)
    setDeckBrowserNotes([])
    setDeckBrowserEditing(null)
    setDeckBrowserSearch('')
  }

  // ─── Knowledge Base Management ──────────────────────────────────────────
  const loadKnowledgeFiles = async () => {
    try {
      const res = await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}`).then(r => r.json())
      setKnowledgeFiles(res.files || [])
    } catch { setKnowledgeFiles([]) }
  }

  const uploadKnowledgeFile = async (file) => {
    console.log('[Knowledge] uploading file:', file.name, 'size:', file.size, 'type:', file.type)
    try {
      const text = await file.text()
      console.log('[Knowledge] file content length:', text.length)
      const res = await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content: text }),
      })
      const data = await res.json()
      console.log('[Knowledge] upload result:', data)
      await loadKnowledgeFiles()
    } catch (err) {
      console.error('[Knowledge] upload failed:', err.message)
    }
  }

  const deleteKnowledgeFile = async (fileName) => {
    await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}&file=${encodeURIComponent(fileName)}`, { method: 'DELETE' })
    loadKnowledgeFiles()
  }

  const toggleKnowledgeFile = async (fileName) => {
    await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}&file=${encodeURIComponent(fileName)}`, { method: 'PATCH' })
    loadKnowledgeFiles()
  }

  const handleKnowledgeDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setKnowledgeDragging(false)
    setDragging(false)
    const allFiles = Array.from(e.dataTransfer.files)
    console.log('[Knowledge] drop event, files:', allFiles.map(f => f.name))
    const textFiles = allFiles.filter(f => f.name.match(/\.(txt|md)$/i))
    if (textFiles.length === 0) {
      console.log('[Knowledge] no .txt/.md files in drop')
      return
    }
    textFiles.forEach(uploadKnowledgeFile)
  }

  const handleKnowledgeFileInput = (e) => {
    const files = Array.from(e.target.files).filter(f => f.name.match(/\.(txt|md)$/i))
    files.forEach(uploadKnowledgeFile)
    e.target.value = ''
  }

  // ─── AI Format Editing ───────────────────────────────────────────────────
  const editModeWithAI = async (instruction) => {
    if (!apiKey || modeCreating) return
    setModeCreating(true)
    try {
      const prompt = `Current study mode config:
${JSON.stringify({ name: activeMode.name, type: activeMode.type, fields: activeMode.fields, frontTemplate: activeMode.frontTemplate, backTemplate: activeMode.backTemplate, tagRules: activeMode.tagRules, questionPrompt: activeMode.studyRules?.questionPrompt || '' }, null, 2)}

User's request: "${instruction}"

Modify the config according to the user's request. Return the FULL updated JSON config with all fields (name, type, fields, frontTemplate, backTemplate, tagRules, questionPrompt). Keep everything the user didn't ask to change.

Output ONLY raw JSON. No markdown, no backticks.`

      const text = await providerConfig.call(apiKey,
        'You modify study mode configurations. Always respond with valid JSON only.',
        prompt
      )
      const config = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
      const updates = {
        name: config.name || activeMode.name,
        type: config.type || activeMode.type,
        fields: config.fields || activeMode.fields,
        frontTemplate: config.frontTemplate || activeMode.frontTemplate,
        backTemplate: config.backTemplate || activeMode.backTemplate,
        tagRules: config.tagRules || activeMode.tagRules,
      }
      if (config.questionPrompt) {
        updates.studyRules = { ...(activeMode.studyRules || defaultStudyRules), questionPrompt: config.questionPrompt }
      }
      updateActiveMode(updates)
      console.log('[Mode] updated via AI:', config)
    } catch (err) {
      console.error('[Mode] AI edit failed:', err.message)
      setAnkiError('Format edit failed: ' + err.message)
    } finally {
      setModeCreating(false)
    }
  }

  // ─── Study Session (interleaved multi-card) ────────────────────────────
  const stripHtml = (html) => {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    return (tmp.textContent || tmp.innerText || '').trim()
  }
  const getCardFront = (card) => {
    const fields = card.fields ? Object.values(card.fields) : []
    const firstField = [...fields].sort((a, b) => a.order - b.order)[0]
    return stripHtml(firstField?.value || card.question || '')
  }
  const getCardBack = (card) => {
    const fields = card.fields ? Object.values(card.fields) : []
    const sorted = [...fields].sort((a, b) => a.order - b.order)
    return stripHtml(sorted[1]?.value || card.answer || '')
  }

  const startStudySession = async () => {
    if (!ankiConnected) { setAnkiError('Anki is not connected'); return }
    const decks = await ankiGetDecks().catch(() => [])
    setAnkiDecks(decks)
    setStudyDeck(ankiDeck || decks[0] || '')
    setStudyActive(true)
    setStudyPhase('pick')
  }

  const beginStudy = async (deck) => {
    setStudyLoading(true)
    setAnkiError(null)
    try {
      let cardIds = await ankiFindCards(`deck:"${deck}" is:due`)
      if (!cardIds || cardIds.length === 0) cardIds = await ankiFindCards(`deck:"${deck}"`)
      if (!cardIds || cardIds.length === 0) { setAnkiError('No cards found in this deck'); setStudyLoading(false); return }

      // Load knowledge base
      const knowledgeRes = await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}`).then(r => r.json()).catch(() => ({ content: null, fileCount: 0 }))
      setStudyKnowledge(knowledgeRes.content)
      setStudyKnowledgeCount(knowledgeRes.fileCount || 0)
      console.log('[Study] knowledge base:', knowledgeRes.fileCount || 0, 'files')

      // Fetch live deck stats
      const stats = await ankiGetDeckStats([deck]).catch(() => ({}))
      const deckStat = Object.values(stats)[0] || { new_count: 0, learn_count: 0, review_count: 0 }
      setStudyDeckStats(deckStat)

      const shuffled = [...cardIds].sort(() => Math.random() - 0.5)
      const cards = await ankiCardsInfo(shuffled.slice(0, 50))
      console.log('[Study] loaded', cards.length, 'cards from deck:', deck)
      setStudyAllCards(cards)
      setStudyBatchIdx(0)
      setStudyStats({ easy: 0, good: 0, hard: 0, again: 0 })
      await startBatch(cards, 0)
    } catch (err) {
      console.error('[Study] failed to start:', err.message)
      setAnkiError('Study failed: ' + err.message)
    } finally {
      setStudyLoading(false)
    }
  }

  const startBatch = async (allCards, batchStart) => {
    const rules = activeMode.studyRules || (activeMode.type === 'language' ? defaultStudyRules : defaultGeneralStudyRules)
    const cardsAtOnce = rules.cardsAtOnce || 3
    const questionsPerCard = rules.questionsPerCard || 3
    const questionPrompt = rules.questionPrompt || defaultStudyRules.questionPrompt

    const batchCards = allCards.slice(batchStart, batchStart + cardsAtOnce)
    if (batchCards.length === 0) { setStudyPhase('summary'); return }

    setStudyLoading(true)

    // Generate questions for all cards in batch
    const cardStates = []
    for (const card of batchCards) {
      const front = getCardFront(card)
      const back = getCardBack(card)
      let questions = []
      try {
        const studyLang = rules.studyLanguage || 'English'
        const knowledgeContext = studyKnowledge ? `\n\nReference material for this subject:\n${studyKnowledge.substring(0, 4000)}\n\nUse this context to create more specific questions when relevant.` : ''
        const prompt = `Card front: "${front}"\nCard back: "${back}"\n\nGenerate exactly ${questionsPerCard} quiz questions for this flashcard.\n\n${questionPrompt}\n\nGenerate all questions in ${studyLang}. The student will answer in ${studyLang}.${knowledgeContext}\n\nReturn a JSON array of ${questionsPerCard} question strings. Output ONLY raw JSON. No markdown, no backticks.`
        const text = await providerConfig.call(apiKey, 'You generate flashcard quiz questions. Always respond with a valid JSON array of strings.', prompt)
        questions = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
        if (!Array.isArray(questions)) questions = [`What does "${front}" mean?`]
      } catch {
        questions = [`Define "${front}".`, `Explain "${front}" in your own words.`, `Why is "${front}" important?`]
      }
      cardStates.push({ cardId: card.cardId, front, back, questions: questions.slice(0, questionsPerCard), answers: [], results: [], done: false })
    }

    // Build interleaved queue — round-robin questions across cards
    const queue = []
    for (let q = 0; q < questionsPerCard; q++) {
      const indices = [...Array(cardStates.length).keys()].sort(() => Math.random() - 0.5)
      for (const ci of indices) {
        if (q < cardStates[ci].questions.length) {
          queue.push({ cardIdx: ci, questionIdx: q })
        }
      }
    }

    console.log('[Study] batch started:', cardStates.length, 'cards,', queue.length, 'questions interleaved')
    setStudyCardState(cardStates)
    setStudyQueue(queue)
    setStudyQueueIdx(0)
    setStudyInput('')
    setStudyLoading(false)
    setStudyPhase('question')
  }

  const submitStudyAnswer = async () => {
    if (!studyInput.trim() || studyLoading) return
    const answer = studyInput.trim()
    const current = studyQueue[studyQueueIdx]
    const cs = studyCardState[current.cardIdx]
    const question = cs.questions[current.questionIdx]

    setStudyLoading(true)
    setStudyInput('')

    try {
      const rules = activeMode.studyRules || defaultStudyRules
      const studyLang = rules.studyLanguage || 'English'
      const grammarOn = rules.grammarFeedback || false
      const knowledgeContext = studyKnowledge ? `\n\nReference material:\n${studyKnowledge.substring(0, 2000)}` : ''
      const grammarInstructions = grammarOn
        ? `\n\nAlso evaluate grammar/spelling in ${studyLang}. Include:\n- "grammarNote": grammar/spelling correction if any issues, or null if perfect\n- "grammarRelevant": true ONLY if the grammar error directly relates to what the card is testing (e.g. wrong conjugation on a conjugation card), false for general typos`
        : ''
      const responseFormat = grammarOn
        ? '{"correct": true/false, "feedback": "brief explanation", "grammarNote": "correction or null", "grammarRelevant": true/false}'
        : '{"correct": true/false, "feedback": "brief explanation"}'
      const prompt = `You are evaluating a student's answer to a flashcard question.\n\nCard front: "${cs.front}"\nCard back: "${cs.back}"\nQuestion: "${question}"\nStudent's answer: "${answer}"\n\nThe student is answering in ${studyLang}.\nEvaluate: is the answer factually/conceptually correct based on the card?${grammarInstructions}${knowledgeContext}\nRespond with JSON: ${responseFormat}`
      const text = await providerConfig.call(apiKey, 'You evaluate flashcard answers. Always respond with valid JSON only.', prompt)
      const result = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))

      // Update card state
      const newStates = [...studyCardState]
      newStates[current.cardIdx] = {
        ...newStates[current.cardIdx],
        answers: [...newStates[current.cardIdx].answers, answer],
        results: [...newStates[current.cardIdx].results, result],
      }

      // Check if this card is done (all questions answered)
      const qpc = (activeMode.studyRules || defaultStudyRules).questionsPerCard || 3
      if (newStates[current.cardIdx].results.length >= qpc) {
        newStates[current.cardIdx].done = true
        // Rate this card
        const wrongCount = newStates[current.cardIdx].results.filter((r) => !r.correct || r.grammarRelevant).length
        let ease, label
        if (wrongCount === 0) { ease = 4; label = 'easy' }
        else if (wrongCount === 1) { ease = 3; label = 'good' }
        else if (wrongCount >= qpc) { ease = 1; label = 'again' }
        else { ease = 2; label = 'hard' }
        newStates[current.cardIdx].rating = label
        try {
          await ankiAnswerCards([{ cardId: cs.cardId, ease }])
          ankiSync().catch(() => {})
        } catch (err) {
          console.warn('[Study] failed to rate card (may be deleted):', err.message)
        }
        // Refresh deck stats live
        ankiGetDeckStats([studyDeck]).then((s) => {
          const ds = Object.values(s)[0]
          if (ds) setStudyDeckStats(ds)
        }).catch(() => {})
        setStudyStats((prev) => ({ ...prev, [label]: prev[label] + 1 }))
        console.log('[Study] card done:', cs.front, '→', label)
      }
      setStudyCardState(newStates)

      // Advance queue
      const nextQIdx = studyQueueIdx + 1
      if (nextQIdx >= studyQueue.length) {
        setStudyPhase('batchFeedback')
      } else {
        setStudyQueueIdx(nextQIdx)
      }
    } catch (err) {
      console.error('[Study] evaluation failed:', err.message)
    } finally {
      setStudyLoading(false)
    }
  }

  const nextBatch = async () => {
    const rules = activeMode.studyRules || defaultStudyRules
    const cardsAtOnce = rules.cardsAtOnce || 3
    const nextStart = studyBatchIdx + cardsAtOnce
    if (nextStart >= studyAllCards.length) {
      setStudyPhase('summary')
    } else {
      setStudyBatchIdx(nextStart)
      setStudyLoading(true)
      await startBatch(studyAllCards, nextStart)
    }
  }

  const exitStudy = () => {
    setStudyActive(false)
    setStudyAllCards([])
    setStudyCardState([])
    setStudyQueue([])
    setStudyQueueIdx(0)
    setStudyPhase('pick')
    setStudyInput('')
    setAnkiError(null)
  }

  // ─── AI Mode Creation ────────────────────────────────────────────────────
  const createMode = async (description) => {
    if (!apiKey || modeCreating) return
    setModeCreating(true)
    try {
      const prompt = `The user wants to create a study mode for: "${description}"

Generate a JSON config for this study mode:
- "name": short name (2-3 words max, e.g. "Security+", "Spanish", "Organic Chemistry")
- "type": "language" if this is about learning a foreign language, "general" otherwise
- "fields": object with field names as keys and true as values. These become the JSON keys the AI will fill when generating flashcards. For language modes use: { "pronunciation": true, "translation": true, "synonyms": true, "definition": true, "example": true }. For general modes, choose 3-5 fields appropriate to the subject (e.g. { "definition": true, "example": true, "category": true, "keyPoints": true }).
- "frontTemplate": card front using {fieldName} placeholders. For language: "{word} ({partOfSpeech})". For general: "{term}" or similar.
- "backTemplate": card back using {fieldName} placeholders and \\n for newlines. Use descriptive labels before each placeholder.
- "tagRules": instructions for AI tag generation. Include "screenlens" always. Add subject-specific categories. Tags should be lowercase, no spaces (use hyphens).
- "questionPrompt": instructions for AI when generating study/quiz questions for flashcards in this mode. Describe what kinds of questions to ask (e.g. definitions, real-world scenarios, comparisons). Be specific to the subject matter.

Output ONLY raw JSON. No markdown, no backticks.`

      const text = await providerConfig.call(apiKey,
        'You configure study modes for a learning app. Always respond with valid JSON only.',
        prompt
      )
      const config = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))

      const newId = Math.max(0, ...modes.map((m) => m.id)) + 1
      const newMode = {
        id: newId,
        name: config.name || description.slice(0, 20),
        type: config.type || 'general',
        description,
        fields: config.fields || { definition: true, example: true },
        frontTemplate: config.frontTemplate || '{term}',
        backTemplate: config.backTemplate || 'Definition: {definition}',
        tagRules: config.tagRules || 'Include: screenlens',
        studyRules: {
          questionsPerCard: 3,
          questionPrompt: config.questionPrompt || ((config.type || 'general') === 'language' ? defaultStudyRules : defaultGeneralStudyRules).questionPrompt,
          ratingRules: defaultStudyRules.ratingRules,
        },
      }
      saveModes([...modes, newMode], newId)
      console.log('[Mode] created:', newMode)
    } catch (err) {
      console.error('[Mode] creation failed:', err.message)
      setAnkiError('Mode creation failed: ' + err.message)
    } finally {
      setModeCreating(false)
    }
  }

  const syncToAnki = async (idx) => {
    if (!ankiCard || ankiSyncing) return
    console.log('[Anki] syncing card to deck:', ankiDeck)
    setAnkiSyncing(true)
    setAnkiError(null)
    try {
      // Re-check connection
      const connected = await ankiPing()
      setAnkiConnected(connected)
      if (!connected) {
        const msg = 'Anki is not running — open Anki with AnkiConnect addon to sync'
        console.log('[Anki] sync failed:', msg)
        setAnkiError(msg)
        return
      }
      // Ensure target deck exists — create it if not
      const decks = await ankiGetDecks().catch(() => [])
      setAnkiDecks(decks)
      if (!decks.includes(ankiDeck)) {
        console.log('[Anki] deck not found, creating:', ankiDeck)
        await ankiCreateDeck(ankiDeck)
        const updated = await ankiGetDecks().catch(() => [])
        setAnkiDecks(updated)
      }
      const noteId = await ankiAddNote(ankiDeck, ankiCard.front, ankiCard.back, ankiCard.tags)
      console.log('[Anki] card synced successfully, noteId:', noteId, 'deck:', ankiDeck)
      // Sync to AnkiWeb
      ankiSync().catch((err) => console.warn('[Anki] AnkiWeb sync failed:', err.message))
      setAnkiSynced((prev) => ({ ...prev, [idx]: true }))
    } catch (err) {
      console.error('[Anki] sync error:', err.message)
      setAnkiError(err.message)
    } finally {
      setAnkiSyncing(false)
    }
  }

  // ─── Deep Explain (uses Sonnet for thorough breakdown) ────────────────────
  const deepExplain = useCallback(async (word) => {
    if (!apiKey || deepExplaining) return
    setDeepExplaining(true)
    setDeepExplanation(null)
    try {
      const prompt = `Word: "${word.text}" (translated: "${word.translation}")
Context: "${getContext()}"

In 3-4 short sentences, explain why "${word.text}" means "${word.translation}" in this context. Be concise and direct. No filler, no repetition, no grammar analysis, no examples. Just the meaning and why.`
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          system: 'You are a concise language tutor. Explain in 3-4 sentences max. No fluff.',
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      const text = data.content?.map((c) => (c.type === 'text' ? c.text : '')).join('')
      setDeepExplanation(text)
    } catch (err) {
      setDeepExplanation('Failed: ' + err.message)
    } finally {
      setDeepExplaining(false)
    }
  }, [apiKey, deepExplaining, ocrWords])

  // ─── Word Study (conjugations, usage, regional) ────────────────────────────
  const fetchWordStudy = useCallback(async (word) => {
    if (!apiKey || wordStudyLoading) return
    setWordStudyLoading(true)
    setWordStudy(null); setConjugation(null)
    try {
      const langLabel = LANGS.find((l) => l.code === language)?.label || 'the source language'
      const prompt = `Word: "${word.text}" (${langLabel}) → "${word.translation}"

Give a quick-reference word study. Be CONCISE — use short bullet points, not paragraphs. Each section should be 1-3 lines max.

ROOT FORM: Just the dictionary form and part of speech. One line.

FORMS: If verb: list key conjugations as "tense: form = English" on separate lines. If noun/adj: singular/plural, gender. Keep it brief.

EXAMPLES: 2 short example sentences with translations. Format: "sentence" = "translation"

REGIONAL: One line — is it universal or regional? If regional, list alternatives briefly.

REGISTER: One word — formal/informal/neutral/slang.

RELATED: 3 related words with brief English meaning, one per line.

No paragraphs. No explanations. Just the facts. Use the section labels above.`
      const text = await providerConfig.call(apiKey, 'You are a concise dictionary. Short bullet points only. No paragraphs, no filler.', prompt)
      setWordStudy(text)
    } catch (err) {
      setWordStudy('Failed: ' + err.message)
    } finally {
      setWordStudyLoading(false)
    }
  }, [apiKey, wordStudyLoading, ocrWords, language, providerConfig])

  // ─── Conjugation ───────────────────────────────────────────────────────────
  const fetchConjugation = useCallback(async (word) => {
    if (!apiKey || conjugationLoading) return
    setConjugationLoading(true)
    setConjugation(null)
    try {
      const langLabel = LANGS.find((l) => l.code === language)?.label || 'the source language'
      const prompt = `Word: "${word.text}" (${langLabel})

Show the full conjugation table for this word. If it's a verb, show all major tenses. If noun/adjective, show all forms.

For verbs, use this format (one line each, no extra text):
INFINITIVE: [infinitive form]
PRESENT: yo [form], tú [form], él [form], nosotros [form], ellos [form]
PRETERITE: yo [form], tú [form], él [form], nosotros [form], ellos [form]
IMPERFECT: yo [form], tú [form], él [form], nosotros [form], ellos [form]
FUTURE: yo [form], tú [form], él [form], nosotros [form], ellos [form]
SUBJUNCTIVE: yo [form], tú [form], él [form], nosotros [form], ellos [form]
IMPERATIVE: tú [form], usted [form], nosotros [form]

For nouns: SINGULAR: [form], PLURAL: [form], GENDER: [m/f]
For adjectives: MASC SING: [form], FEM SING: [form], MASC PL: [form], FEM PL: [form]

No explanations. Just the forms. Use the section labels above.`
      const text = await providerConfig.call(apiKey, 'You are a conjugation table generator. Only output the forms, no commentary.', prompt)
      setConjugation(text)
    } catch (err) {
      setConjugation('Failed: ' + err.message)
    } finally {
      setConjugationLoading(false)
    }
  }, [apiKey, conjugationLoading, language, providerConfig])

  // ─── Chat (ask anything about the word) ───────────────────────────────────
  const sendChat = useCallback(async (word) => {
    const q = chatInput.trim()
    if (!q || !apiKey || chatLoading) return
    setChatInput('')
    setChatMessages((prev) => [...prev, { role: 'user', text: q }])
    setChatLoading(true)
    try {
      const systemPrompt = `You are a concise language tutor. Word: "${word.text}" = "${word.translation}". Context: "${getContext()}"
Rules: Answer in 1-2 short sentences. Be direct. No filler, no repetition, no over-explaining.`
      const messages = [
        ...chatMessages.map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: q },
      ]
      // Build the full conversation as a single user message for simplicity
      const fullPrompt = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
      const text = await providerConfig.call(apiKey, systemPrompt, fullPrompt)
      setChatMessages((prev) => [...prev, { role: 'assistant', text }])
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: 'assistant', text: 'Error: ' + err.message }])
    } finally {
      setChatLoading(false)
    }
  }, [apiKey, chatInput, chatLoading, chatMessages, ocrWords, providerConfig])

  const reset = () => {
    setScreenshot(null); setOcrWords([]); setStage('idle')
    setError(null); setHoveredIdx(null); setPinnedIdx(null)
    setExplanation(null); setDeepExplanation(null); setWordStudy(null)
    setChatMessages([]); setChatInput(''); setExpanded(false)
  }

  // ─── Word Overlay Renderer ─────────────────────────────────────────────────
  const renderWordOverlays = () => {
    if (!imgDims.w || !imgDims.h) return null

    // Pre-compute corrected bboxes:
    // 1. Estimate expected width from per-char metrics to fix narrow bboxes (e.g. "Tiempo" missing "o")
    // 2. Clamp same-row overlaps so adjacent words don't visually bleed into each other
    const boxes = ocrWords.map((word) => {
      let x0 = word.bbox.x0, y0 = word.bbox.y0, x1 = word.bbox.x1, y1 = word.bbox.y1
      const bboxW = x1 - x0
      const bboxH = y1 - y0
      const charCount = word.text.length
      if (charCount > 0 && bboxH > 0) {
        // Expected width based on character count and height (typical char aspect ~0.55)
        const expectedW = charCount * bboxH * 0.55
        if (expectedW > bboxW * 1.15) {
          // Bbox is suspiciously narrow for this word — extend right edge
          x1 = Math.round(x0 + expectedW)
        }
      }
      return { x0, y0, x1, y1 }
    })

    // Clamp same-row overlaps: if two words overlap horizontally, trim the left one's right edge
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const avgH = ((a.y1 - a.y0) + (b.y1 - b.y0)) / 2
        if (Math.abs(a.y0 - b.y0) > avgH * 0.5) continue // different row
        // Same row — if they overlap, trim
        if (a.x1 > b.x0 && a.x0 < b.x0) {
          a.x1 = b.x0 - 1
        } else if (b.x1 > a.x0 && b.x0 < a.x0) {
          b.x1 = a.x0 - 1
        }
      }
    }

    return ocrWords.map((word, i) => {
      const box = boxes[i]
      const x = (box.x0 / imgDims.w) * 100
      const y = (box.y0 / imgDims.h) * 100
      const w = Math.max(0, ((box.x1 - box.x0) / imgDims.w) * 100)
      const h = Math.max(0, ((box.y1 - box.y0) / imgDims.h) * 100)
      const isActive = hoveredIdx === i || pinnedIdx === i
      const isPinned = pinnedIdx === i

      // Get color based on category and part of speech
      const catColor = CATEGORY_COLORS[word.category]
      const posColor = POS_COLORS[word.partOfSpeech] || POS_COLORS.other
      const wordColor = (word.category === 'name') ? catColor
        : (word.category === 'target' || word.category === 'number') ? catColor
        : posColor

      return (
        <span
          key={i}
          onMouseEnter={(e) => handleWordHover(i, e)}
          onMouseLeave={handleWordLeave}
          onClick={(e) => handleWordClick(i, e)}
          style={{
            position: 'absolute',
            left: `${x}%`,
            top: `${y}%`,
            width: `${w}%`,
            height: `${h}%`,
            background: isActive
              ? isPinned ? 'rgba(88, 166, 255, 0.45)' : (wordColor.bg.replace(/[\d.]+\)$/, '0.35)'))
              : showHighlights ? wordColor.bg : 'transparent',
            border: isActive
              ? isPinned ? '2px solid rgba(88, 166, 255, 0.85)' : `2px solid ${wordColor.border}`
              : showHighlights && wordColor.border !== 'transparent'
                ? `1px solid ${wordColor.border}`
                : '1px solid transparent',
            borderRadius: 2,
            cursor: 'pointer',
            transition: 'background 0.1s, border 0.1s',
            zIndex: isActive ? 10 : 1,
            boxSizing: 'border-box',
          }}
        />
      )
    })
  }

  const activeIdx = pinnedIdx !== null ? pinnedIdx : hoveredIdx
  const activeWord = activeIdx !== null ? ocrWords[activeIdx] : null
  const isPinned = pinnedIdx !== null

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={S.app}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files[0]) loadImageFromFile(e.target.files[0]); e.target.value = '' }}
      />

      {/* ── Drag Overlay ─────────────────────────────────────────────────────── */}
      {dragging && !showKnowledgeSection && (
        <div style={S.dragOverlay}>
          <div style={S.dragBox}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
                stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <p style={{ fontSize: 18, fontWeight: 600, color: '#e6edf3', margin: '12px 0 0' }}>
              Drop image here
            </p>
          </div>
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      {!isOverlay && <header style={S.header}>
        <div style={S.headerLeft}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="3" width="20" height="18" rx="2" stroke="#58a6ff" strokeWidth="2"/>
            <circle cx="18" cy="7" r="4" fill="#58a6ff"/>
          </svg>
          <h1 style={S.title}>ScreenLens</h1>
          <span style={S.badge}>LOCAL</span>
        </div>
        <div style={S.headerRight}>
          {activeMode.type === 'language' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#1c2129', border: '1px solid #2a3040', borderRadius: 6, padding: '2px 4px' }}>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...S.select, border: 'none', background: 'transparent', padding: '4px 6px' }}>
                {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
              <span style={{ color: '#58a6ff', fontSize: 14, fontWeight: 700 }}>→</span>
              <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)} style={{ ...S.select, border: 'none', background: 'transparent', padding: '4px 6px' }}>
                {LANGS.filter((l) => l.code !== 'auto').map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
          )}

          {stage === 'done' && (
            <button onClick={() => setShowHighlights(!showHighlights)} style={{
              ...S.ghostBtn,
              color: showHighlights ? '#d2a8ff' : '#7d8590',
              borderColor: showHighlights ? 'rgba(210,168,255,0.25)' : '#2a3040',
            }}>
              {showHighlights ? '● Highlights' : '○ Highlights'}
            </button>
          )}

          {stage !== 'idle' && <button onClick={reset} style={S.ghostBtn}>New</button>}

          {screenshot && !loading && stage === 'done' && (
            <button onClick={() => analyzeImage(screenshot)} style={S.ghostBtn}>Re-analyze</button>
          )}

          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={{ ...S.select, borderColor: `${providerConfig.color}44`, color: providerConfig.color }}
          >
            {Object.entries(PROVIDERS).map(([key, p]) => (
              <option key={key} value={key}>{p.label}</option>
            ))}
          </select>

          <div style={{ display: 'flex', gap: 0 }}>
            <button onClick={() => { setShowModePanel(!showModePanel); if (showModePanel) setModeSettingsTab(null) }} style={{
              ...S.ghostBtn, color: '#58a6ff', borderColor: 'rgba(88,166,255,0.25)',
              borderRadius: '6px 0 0 6px', borderRight: 'none',
            }}>
              {activeMode.type === 'language' ? '\u{1F310}' : '\u{1F4DA}'} {activeMode.name}
            </button>
            <button onClick={() => {
              setShowSettings(!showSettings)
              if (showSettings) { setSettingsSection(null); setShowAnkiSection(false); setShowKnowledgeSection(false) }
            }} style={{
              ...S.ghostBtn, borderRadius: '0 6px 6px 0',
              color: showSettings ? '#e6edf3' : '#7d8590',
              borderColor: showSettings ? 'rgba(230,237,243,0.2)' : 'rgba(88,166,255,0.25)',
              padding: '6px 8px',
            }}>
              {'\u2699\uFE0F'}
            </button>
          </div>

          {ankiConnected && (
            <>
              <button onClick={() => { if (studyActive) { exitStudy() } else { closeDeckBrowser(); startStudySession() } }} disabled={studyLoading} style={{
                ...S.ghostBtn,
                color: studyActive ? '#e6edf3' : '#ffa657',
                borderColor: studyActive ? 'rgba(230,237,243,0.3)' : 'rgba(255,166,87,0.25)',
                opacity: studyLoading ? 0.5 : 1,
              }}>
                {studyLoading ? 'Loading...' : 'Study'}
              </button>
              <button onClick={() => { if (deckBrowserActive) { closeDeckBrowser() } else { exitStudy(); openDeckBrowser() } }} style={{
                ...S.ghostBtn,
                color: deckBrowserActive ? '#e6edf3' : '#d2a8ff',
                borderColor: deckBrowserActive ? 'rgba(230,237,243,0.3)' : 'rgba(210,168,255,0.25)',
              }}>
                Deck
              </button>
            </>
          )}

          <button onClick={() => setShowKeyInput(!showKeyInput)} style={{
            ...S.ghostBtn,
            color: apiKey ? '#7ee787' : '#f85149',
            borderColor: apiKey ? 'rgba(126,231,135,0.25)' : 'rgba(248,81,73,0.25)',
          }}>
            {apiKey ? '🔑 Key Set' : '🔑 Set Key'}
          </button>

          <div style={S.captureGroup}>
            <button onClick={captureScreen} disabled={loading} style={S.captureBtn}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7 }}>
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                  stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="2"/>
              </svg>
              Capture
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={loading} style={S.uploadBtn}>
              Upload
            </button>
          </div>

          <button onClick={async () => {
            if (overlayRunning) {
              // Stop overlay
              try {
                await fetch('/api/launch-overlay', { method: 'DELETE' })
                setOverlayRunning(false)
              } catch {}
            } else {
              // Start overlay
              try {
                const r = await fetch('/api/launch-overlay', { method: 'POST' })
                const d = await r.json()
                if (d.error) { alert(d.error) }
                else { setOverlayRunning(true) }
              } catch (err) {
                alert('Failed to launch overlay: ' + err.message)
              }
            }
          }} style={{
            ...S.ghostBtn,
            color: overlayRunning ? '#7ee787' : '#7d8590',
            borderColor: overlayRunning ? 'rgba(126,231,135,0.3)' : '#2a3040',
            background: overlayRunning ? 'rgba(126,231,135,0.08)' : 'transparent',
          }}>
            {overlayRunning ? '\u25CF' : '\u25CB'} Overlay
          </button>

          <kbd style={S.kbd}>Ctrl+Shift+S</kbd>
        </div>
      </header>}

      {/* ── API Key Input ────────────────────────────────────────────────────── */}
      {showKeyInput && (
        <div style={S.keyBar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: providerConfig.color, flexShrink: 0 }} />
            <label style={S.keyLabel}>{providerConfig.label} API Key:</label>
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setCurrentKey(e.target.value)}
            placeholder={providerConfig.placeholder}
            style={S.keyInput}
          />
          <a
            href={providerConfig.url}
            target="_blank"
            rel="noopener noreferrer"
            style={S.getKeyLink}
          >
            Get key
          </a>
          <button onClick={() => setShowKeyInput(false)} style={S.keyDone}>
            {apiKey ? 'Done' : 'Close'}
          </button>
          <span style={{ fontSize: 11, color: '#7d8590' }}>Stored in localStorage only</span>
        </div>
      )}

      {showModePanel && (
        <div style={{ ...S.keyBar, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          {/* Mode list + create */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff' }}>Modes:</span>
            {modes.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {editingModeName === m.id ? (
                  <input autoFocus defaultValue={m.name}
                    onBlur={(e) => renameMode(m.id, e.target.value || m.name)}
                    onKeyDown={(e) => { if (e.key === 'Enter') renameMode(m.id, e.target.value || m.name) }}
                    style={{ ...S.keyInput, width: 120, fontSize: 11, padding: '4px 8px' }}
                  />
                ) : (
                  <button
                    onClick={() => {
                      if (m.id === activeModeId) { setEditingModeName(m.id) }
                      else { setActiveModeId(m.id); saveModes(modes, m.id) }
                    }}
                    title={`${m.description || m.name}\nDouble-click to rename`}
                    style={{
                      padding: '4px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                      background: m.id === activeModeId ? 'rgba(88,166,255,.2)' : 'rgba(125,133,144,.1)',
                      color: m.id === activeModeId ? '#58a6ff' : '#7d8590',
                      border: m.id === activeModeId ? '1px solid rgba(88,166,255,.4)' : '1px solid #2a3040',
                      fontWeight: m.id === activeModeId ? 700 : 400,
                    }}
                  >
                    {m.type === 'language' ? '\u{1F310}' : '\u{1F4DA}'} {m.name}
                  </button>
                )}
                {modes.length > 1 && (
                  <span onClick={() => { if (confirm(`Delete mode "${m.name}"? This will remove all settings for this mode.`)) deleteMode(m.id) }} style={{ cursor: 'pointer', color: '#7d8590', fontSize: 12 }}>&times;</span>
                )}
              </div>
            ))}
          </div>

          {/* Create new mode */}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={modeEditInput}
              onChange={(e) => setModeEditInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && modeEditInput.trim()) { createMode(modeEditInput.trim()); setModeEditInput('') } }}
              placeholder="What do you want to learn? (e.g. Spanish, Security+, Organic Chemistry)"
              style={{ ...S.keyInput, flex: 1 }}
              disabled={modeCreating}
            />
            <button
              onClick={() => { if (modeEditInput.trim()) { createMode(modeEditInput.trim()); setModeEditInput('') } }}
              disabled={modeCreating || !modeEditInput.trim()}
              style={{ ...S.keyDone, opacity: modeCreating || !modeEditInput.trim() ? 0.5 : 1 }}
            >
              {modeCreating ? 'Creating...' : 'Create'}
            </button>
          </div>

          {/* Bottom buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addDefaultMode} style={{ ...S.ghostBtn, fontSize: 10, color: '#7ee787', borderColor: 'rgba(126,231,135,.25)' }}>
              + Default Mode
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={() => { setShowModePanel(false); setShowSettings(false); setSettingsSection(null); setShowAnkiSection(false); setShowKnowledgeSection(false) }} style={S.keyDone}>Done</button>
          </div>
        </div>
      )}

      {/* Settings panel — independent of mode panel */}
      {showSettings && (
        <div style={{ ...S.keyBar, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#7d8590', display: 'flex', alignItems: 'center', gap: 8 }}>
            Settings for:
            <select value={activeModeId} onChange={(e) => { const id = parseInt(e.target.value); setActiveModeId(id); saveModes(modes, id) }}
              style={{ ...S.select, fontSize: 11, padding: '3px 8px', color: '#58a6ff', borderColor: 'rgba(88,166,255,.3)', background: 'rgba(88,166,255,.08)' }}>
              {modes.map((m) => <option key={m.id} value={m.id}>{m.type === 'language' ? '\u{1F310}' : '\u{1F4DA}'} {m.name}</option>)}
            </select>
            {editingModeName === activeModeId ? (
              <input autoFocus defaultValue={activeMode.name}
                onBlur={(e) => renameMode(activeModeId, e.target.value || activeMode.name)}
                onKeyDown={(e) => { if (e.key === 'Enter') renameMode(activeModeId, e.target.value || activeMode.name) }}
                style={{ ...S.keyInput, width: 120, fontSize: 11, padding: '2px 6px' }}
              />
            ) : (
              <span onClick={() => setEditingModeName(activeModeId)} style={{ cursor: 'pointer', color: '#484f58', fontSize: 10 }} title="Click to rename">
                rename
              </span>
            )}
          </div>
          {/* Anki — top-level collapsible */}
          <button
            onClick={() => { setShowAnkiSection(!showAnkiSection); setSettingsSection(null) }}
            style={{
              width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 6,
              fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 700,
              background: showAnkiSection ? 'rgba(88,166,255,.15)' : 'rgba(88,166,255,.06)',
              color: '#58a6ff', border: '1px solid rgba(88,166,255,.25)',
            }}
          >
            {showAnkiSection ? '\u25BC' : '\u25B6'} Anki Settings {ankiConnected ? '' : ankiConnected === false ? '(offline)' : ''}
          </button>

          {showAnkiSection && (
            <div style={{ paddingLeft: 8, borderLeft: '2px solid rgba(88,166,255,.2)', display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* Connection & Deck */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: ankiConnected ? '#7ee787' : ankiConnected === false ? '#d29922' : '#7d8590', flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#7d8590' }}>
                  {ankiConnected ? 'Connected' : ankiConnected === false ? 'Not connected' : 'Checking...'}
                </span>
                {ankiConnected && ankiDecks.length > 0 && (
                  <>
                    <span style={{ fontSize: 11, color: '#7d8590' }}>Deck:</span>
                    <select value={ankiDeck} onChange={(e) => setAnkiDeck(e.target.value)} style={{ ...S.select, minWidth: 120 }}>
                      {ankiDecks.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                )}
                <button onClick={refreshAnkiConnection} style={{ ...S.getKeyLink, fontSize: 10 }}>
                  {ankiConnected === null ? 'Checking...' : 'Refresh'}
                </button>
              </div>

              {/* Card Format — nested collapsible */}
              <button onClick={() => setSettingsSection(settingsSection === 'format' ? 'anki' : 'format')}
                style={{ width: '100%', textAlign: 'left', padding: '5px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', background: settingsSection === 'format' ? 'rgba(210,168,255,.15)' : 'rgba(210,168,255,.06)', color: '#d2a8ff', border: '1px solid rgba(210,168,255,.2)', fontWeight: 600 }}
              >
                {settingsSection === 'format' ? '\u25BC' : '\u25B6'} Card Format
              </button>
              {settingsSection === 'format' && (
                <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 8, borderLeft: '2px solid rgba(210,168,255,.2)', marginLeft: 4 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={modeEditInput} onChange={(e) => setModeEditInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && modeEditInput.trim()) { editModeWithAI(modeEditInput.trim()); setModeEditInput('') } }}
                      placeholder="Ask AI to change format (e.g. 'add a mnemonic field')"
                      style={{ ...S.keyInput, flex: 1, fontSize: 11 }} disabled={modeCreating}
                    />
                    <button onClick={() => { if (modeEditInput.trim()) { editModeWithAI(modeEditInput.trim()); setModeEditInput('') } }}
                      disabled={modeCreating || !modeEditInput.trim()}
                      style={{ ...S.getKeyLink, opacity: modeCreating ? 0.5 : 1, fontSize: 10 }}
                    >{modeCreating ? '...' : 'AI Edit'}</button>
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {Object.entries(ankiFormat.fields).map(([field, enabled]) => (
                      <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: enabled ? '#e6edf3' : '#7d8590', cursor: 'pointer' }}>
                        <input type="checkbox" checked={enabled} onChange={() => updateActiveMode({ fields: { ...ankiFormat.fields, [field]: !enabled } })} /> {field}
                      </label>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 4 }}>Front template</div>
                    <input value={ankiFormat.frontTemplate} onChange={(e) => updateActiveMode({ frontTemplate: e.target.value })} style={{ ...S.keyInput, fontSize: 11 }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 4 }}>Back template</div>
                    <textarea value={ankiFormat.backTemplate} onChange={(e) => updateActiveMode({ backTemplate: e.target.value })} style={{ ...S.keyInput, fontSize: 11, minHeight: 70, resize: 'vertical' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#484f58' }}>Placeholders: {'{word}'} {'{term}'} {'{partOfSpeech}'} {'{pronunciation}'} {'{translation}'} {'{synonyms}'} {'{definition}'} {'{example}'}</div>
                </div>
              )}

              {/* Tag Rules — nested collapsible */}
              <button onClick={() => setSettingsSection(settingsSection === 'tags' ? 'anki' : 'tags')}
                style={{ width: '100%', textAlign: 'left', padding: '5px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', background: settingsSection === 'tags' ? 'rgba(126,231,135,.15)' : 'rgba(126,231,135,.06)', color: '#7ee787', border: '1px solid rgba(126,231,135,.2)', fontWeight: 600 }}
              >
                {settingsSection === 'tags' ? '\u25BC' : '\u25B6'} Tag Rules
              </button>
              {settingsSection === 'tags' && (
                <div style={{ padding: '6px 10px', borderLeft: '2px solid rgba(126,231,135,.2)', marginLeft: 4 }}>
                  <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 4 }}>AI reads these rules when generating tags for cards</div>
                  <textarea value={activeMode.tagRules || ''} onChange={(e) => updateActiveMode({ tagRules: e.target.value })}
                    style={{ ...S.keyInput, fontSize: 11, minHeight: 80, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                    placeholder="Instructions for AI tag generation..." />
                </div>
              )}

              {/* Study Rules — nested collapsible */}
              <button onClick={() => setSettingsSection(settingsSection === 'study' ? 'anki' : 'study')}
                style={{ width: '100%', textAlign: 'left', padding: '5px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', background: settingsSection === 'study' ? 'rgba(255,166,87,.15)' : 'rgba(255,166,87,.06)', color: '#ffa657', border: '1px solid rgba(255,166,87,.2)', fontWeight: 600 }}
              >
                {settingsSection === 'study' ? '\u25BC' : '\u25B6'} Study Rules
              </button>
              {settingsSection === 'study' && (
                <div style={{ padding: '6px 10px', borderLeft: '2px solid rgba(255,166,87,.2)', marginLeft: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Questions per card</div>
                      <input type="number" min="1" max="10" value={activeMode.studyRules?.questionsPerCard || 3}
                        onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), questionsPerCard: parseInt(e.target.value) || 3 } })}
                        style={{ ...S.keyInput, fontSize: 11, width: 60 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Cards at once</div>
                      <input type="number" min="1" max="10" value={activeMode.studyRules?.cardsAtOnce || 3}
                        onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), cardsAtOnce: parseInt(e.target.value) || 3 } })}
                        style={{ ...S.keyInput, fontSize: 11, width: 60 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Quiz language</div>
                      <select value={activeMode.studyRules?.studyLanguage || 'English'}
                        onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), studyLanguage: e.target.value } })}
                        style={{ ...S.select, fontSize: 11, minWidth: 100 }}>
                        {LANGS.filter(l => l.code !== 'auto').map(l => (
                          <option key={l.code} value={l.label}>{l.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Grammar feedback</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#7d8590', cursor: 'pointer' }}>
                        <input type="checkbox" checked={activeMode.studyRules?.grammarFeedback || false}
                          onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), grammarFeedback: e.target.checked } })} />
                        {activeMode.studyRules?.grammarFeedback ? 'On' : 'Off'}
                      </label>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Question generation prompt (AI uses this to create questions per card)</div>
                  <textarea
                    value={activeMode.studyRules?.questionPrompt || (activeMode.type === 'language' ? defaultStudyRules : defaultGeneralStudyRules).questionPrompt}
                    onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), questionPrompt: e.target.value } })}
                    style={{ ...S.keyInput, fontSize: 11, minHeight: 100, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                    placeholder='Describe what kinds of questions the AI should ask...' />
                  <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 2 }}>Rating rules</div>
                  <input value={activeMode.studyRules?.ratingRules || defaultStudyRules.ratingRules}
                    onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), ratingRules: e.target.value } })}
                    style={{ ...S.keyInput, fontSize: 11 }} />
                </div>
              )}

              <div style={{ fontSize: 10, color: '#484f58' }}>Requires AnkiConnect addon (code: 2055492159)</div>
            </div>
          )}

          {/* Knowledge Base — top-level collapsible */}
          <button
            onClick={() => { const opening = !showKnowledgeSection; setShowKnowledgeSection(opening); if (opening) loadKnowledgeFiles() }}
            style={{
              width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 6,
              fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 700,
              background: showKnowledgeSection ? 'rgba(126,231,135,.15)' : 'rgba(126,231,135,.06)',
              color: '#7ee787', border: '1px solid rgba(126,231,135,.25)',
            }}
          >
            {showKnowledgeSection ? '\u25BC' : '\u25B6'} Knowledge Base
          </button>
          {showKnowledgeSection && (() => {
            return (
              <div style={{ paddingLeft: 8, borderLeft: '2px solid rgba(126,231,135,.2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#7d8590' }}>
                  Add .txt or .md files to give the AI extra context for study questions. Optional.
                </div>

                {/* Drag & drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setKnowledgeDragging(true) }}
                  onDragLeave={() => setKnowledgeDragging(false)}
                  onDrop={handleKnowledgeDrop}
                  style={{
                    padding: '16px', borderRadius: 6, textAlign: 'center', cursor: 'pointer',
                    border: `2px dashed ${knowledgeDragging ? 'rgba(126,231,135,.5)' : '#2a3040'}`,
                    background: knowledgeDragging ? 'rgba(126,231,135,.06)' : 'transparent',
                    color: '#7d8590', fontSize: 11,
                  }}
                  onClick={() => document.getElementById('knowledge-file-input').click()}
                >
                  {knowledgeDragging ? 'Drop files here' : 'Drag & drop .txt/.md files here or click to browse'}
                  <input id="knowledge-file-input" type="file" accept=".txt,.md" multiple
                    onChange={handleKnowledgeFileInput} style={{ display: 'none' }} />
                </div>

                {/* File list */}
                {knowledgeFiles.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {knowledgeFiles.map((f) => (
                      <div key={f.name} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
                        background: f.disabled ? 'rgba(125,133,144,.04)' : 'rgba(126,231,135,.04)',
                        border: `1px solid ${f.disabled ? '#2a3040' : 'rgba(126,231,135,.15)'}`,
                        borderRadius: 5, fontSize: 11,
                      }}>
                        <span style={{ flex: 1, color: f.disabled ? '#484f58' : '#c9d1d9', textDecoration: f.disabled ? 'line-through' : 'none' }}>
                          {f.name}
                        </span>
                        <span style={{ color: '#484f58', fontSize: 10 }}>{(f.size / 1024).toFixed(1)}KB</span>
                        <button onClick={() => toggleKnowledgeFile(f.name)}
                          style={{ ...S.ghostBtn, fontSize: 9, padding: '2px 6px', color: f.disabled ? '#7ee787' : '#7d8590' }}>
                          {f.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button onClick={() => { if (confirm(`Delete "${f.name}"? This cannot be undone.`)) deleteKnowledgeFile(f.name) }}
                          style={{ ...S.ghostBtn, fontSize: 9, padding: '2px 6px', color: '#f85149', borderColor: 'rgba(248,81,73,.25)' }}>
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {knowledgeFiles.length === 0 && (
                  <div style={{ fontSize: 10, color: '#484f58' }}>No files added yet</div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Deck Browser ─────────────────────────────────────────────────────── */}
      {deckBrowserActive && (
        <main style={{ ...S.main, display: 'flex', flexDirection: 'column', padding: 20 }}>
          <div style={{ maxWidth: 800, width: '100%', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>Deck Browser</div>
              <button onClick={closeDeckBrowser} style={{ ...S.ghostBtn, fontSize: 10 }}>Close</button>
            </div>

            {/* Deck picker + search */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <select value={deckBrowserDeck} onChange={(e) => { setDeckBrowserDeck(e.target.value); if (e.target.value) loadDeckNotes(e.target.value) }}
                style={{ ...S.select, minWidth: 150 }}>
                <option value="">Select deck...</option>
                {ankiDecks.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {deckBrowserLoading && <span style={{ fontSize: 11, color: '#7d8590' }}>Loading...</span>}
              {deckBrowserNotes.length > 0 && (
                <input value={deckBrowserSearch} onChange={(e) => setDeckBrowserSearch(e.target.value)}
                  placeholder="Search cards..." style={{ ...S.keyInput, flex: 1, fontSize: 12 }} />
              )}
              {deckBrowserNotes.length > 0 && (
                <span style={{ fontSize: 11, color: '#7d8590', alignSelf: 'center' }}>{deckBrowserNotes.length} cards</span>
              )}
            </div>

            {/* Card list */}
            {deckBrowserNotes.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {deckBrowserNotes
                  .filter((n) => {
                    if (!deckBrowserSearch) return true
                    const s = deckBrowserSearch.toLowerCase()
                    return Object.values(n.fields).some((f) => stripHtml(f.value).toLowerCase().includes(s))
                  })
                  .map((note) => {
                    const fields = Object.entries(note.fields).sort(([,a],[,b]) => a.order - b.order)
                    const front = stripHtml(fields[0]?.[1]?.value || '')
                    const back = stripHtml(fields[1]?.[1]?.value || '')
                    const isEditing = deckBrowserEditing === note.noteId

                    return (
                      <div key={note.noteId} style={{
                        border: '1px solid #2a3040', borderRadius: 6, overflow: 'hidden',
                        background: isEditing ? '#1c2129' : 'transparent',
                      }}>
                        {isEditing ? (
                          <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {fields.map(([name]) => (
                              <div key={name}>
                                <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 3, fontWeight: 600 }}>{name}</div>
                                <textarea value={deckBrowserEditFields[name] || ''}
                                  onChange={(e) => setDeckBrowserEditFields((prev) => ({ ...prev, [name]: e.target.value }))}
                                  style={{ ...S.keyInput, fontSize: 12, minHeight: 50, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                                />
                              </div>
                            ))}
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => saveEditNote(note.noteId)} style={{ ...S.captureBtn, borderRadius: 5, fontSize: 11, padding: '5px 12px' }}>Save</button>
                              <button onClick={() => setDeckBrowserEditing(null)} style={{ ...S.ghostBtn, fontSize: 11 }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{front}</span>
                              <span style={{ fontSize: 11, color: '#7d8590', marginLeft: 8 }}>{back.slice(0, 80)}{back.length > 80 ? '...' : ''}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              <button onClick={() => startEditNote(note)} style={{ ...S.ghostBtn, fontSize: 10, padding: '3px 8px' }}>Edit</button>
                              <button onClick={() => { if (confirm(`Delete "${front}"?`)) deleteNote(note.noteId) }}
                                style={{ ...S.ghostBtn, fontSize: 10, padding: '3px 8px', color: '#f85149', borderColor: 'rgba(248,81,73,.25)' }}>Del</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        </main>
      )}

      {/* ── Study Session ────────────────────────────────────────────────────── */}
      {studyActive && (
        <main style={{ ...S.main, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ maxWidth: 600, width: '100%', padding: '40px 20px' }}>

            {/* Study start phase */}
            {studyPhase === 'pick' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 8 }}>Study Session</div>
                {/* Mode & Deck selectors */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', marginBottom: 16 }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 20px',
                    background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8,
                  }}>
                    <span style={{ fontSize: 12, color: '#7d8590' }}>Mode:</span>
                    <select value={activeModeId} onChange={(e) => {
                      const id = parseInt(e.target.value)
                      setActiveModeId(id)
                      saveModes(modes, id)
                      // Load new mode's deck
                      const newMode = modes.find((m) => m.id === id)
                      if (newMode?.ankiDeck) setStudyDeck(newMode.ankiDeck)
                    }} style={{ ...S.select, fontSize: 12, padding: '6px 10px', color: '#58a6ff', borderColor: 'rgba(88,166,255,.3)' }}>
                      {modes.map((m) => <option key={m.id} value={m.id}>{m.type === 'language' ? '\u{1F310}' : '\u{1F4DA}'} {m.name}</option>)}
                    </select>
                  </div>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 20px',
                    background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8,
                  }}>
                    <span style={{ fontSize: 12, color: '#7d8590' }}>Deck:</span>
                    <select value={studyDeck} onChange={(e) => { setStudyDeck(e.target.value); setAnkiDeck(e.target.value) }}
                      style={{ ...S.select, fontSize: 12, padding: '6px 10px' }}>
                      {ankiDecks.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                </div>

                {/* Language & grammar options */}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 20px',
                  background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, marginBottom: 16,
                }}>
                  <span style={{ fontSize: 12, color: '#7d8590' }}>Quiz in:</span>
                  <select value={activeMode.studyRules?.studyLanguage || 'English'}
                    onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), studyLanguage: e.target.value } })}
                    style={{ ...S.select, fontSize: 11, padding: '4px 8px' }}>
                    {LANGS.filter(l => l.code !== 'auto').map(l => (
                      <option key={l.code} value={l.label}>{l.label}</option>
                    ))}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#7d8590', cursor: 'pointer' }}>
                    <input type="checkbox" checked={activeMode.studyRules?.grammarFeedback || false}
                      onChange={(e) => updateActiveMode({ studyRules: { ...(activeMode.studyRules || defaultStudyRules), grammarFeedback: e.target.checked } })}
                    />
                    Grammar feedback
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8 }}>
                  <button onClick={() => beginStudy(studyDeck)} disabled={!studyDeck || studyLoading}
                    style={{ ...S.captureBtn, borderRadius: 6, padding: '10px 24px', fontSize: 13, opacity: !studyDeck || studyLoading ? 0.5 : 1 }}>
                    {studyLoading ? 'Loading cards...' : 'Study Now'}
                  </button>
                  <button onClick={exitStudy} style={{ ...S.ghostBtn }}>Cancel</button>
                </div>
                {ankiError && <div style={{ color: '#f85149', fontSize: 11, marginTop: 8 }}>{ankiError}</div>}
              </div>
            )}

            {/* Summary phase */}
            {studyPhase === 'summary' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 16 }}>Session Complete</div>
                <div style={{ fontSize: 14, color: '#7d8590', marginBottom: 24 }}>
                  {studyStats.easy + studyStats.good + studyStats.hard + studyStats.again} cards studied
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 24 }}>
                  {[
                    { label: 'Easy', count: studyStats.easy, color: '#7ee787' },
                    { label: 'Good', count: studyStats.good, color: '#58a6ff' },
                    { label: 'Hard', count: studyStats.hard, color: '#d29922' },
                    { label: 'Again', count: studyStats.again, color: '#f85149' },
                  ].map(({ label, count, color }) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color }}>{count}</div>
                      <div style={{ fontSize: 11, color: '#7d8590' }}>{label}</div>
                    </div>
                  ))}
                </div>
                <button onClick={exitStudy} style={{ ...S.captureBtn, borderRadius: 6 }}>Done</button>
              </div>
            )}

            {/* Interleaved question phase */}
            {studyPhase === 'question' && studyQueue.length > 0 && (() => {
              const current = studyQueue[studyQueueIdx]
              const cs = studyCardState[current.cardIdx]
              const question = cs.questions[current.questionIdx]
              return (
                <div>
                  {/* Header with Anki-style counts */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                      <span style={{ color: '#58a6ff' }}>{studyDeckStats.new_count || 0} <span style={{ fontSize: 10, color: '#7d8590' }}>New</span></span>
                      <span style={{ color: '#f85149' }}>{studyDeckStats.learn_count || 0} <span style={{ fontSize: 10, color: '#7d8590' }}>Learn</span></span>
                      <span style={{ color: '#7ee787' }}>{studyDeckStats.review_count || 0} <span style={{ fontSize: 10, color: '#7d8590' }}>Due</span></span>
                    </div>
                    <button onClick={exitStudy} style={{ ...S.ghostBtn, fontSize: 10 }}>Exit Study</button>
                  </div>

                  {/* Current card front */}
                  <div style={{
                    background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8,
                    padding: '16px 20px', marginBottom: 12, textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>{cs.front}</div>
                  </div>

                  {/* Question */}
                  <div style={{ fontSize: 13, color: '#e6edf3', fontWeight: 600, marginBottom: 8 }}>
                    {question}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={studyInput}
                      onChange={(e) => setStudyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitStudyAnswer() }}
                      placeholder="Type your answer..."
                      style={{ ...S.keyInput, flex: 1, fontSize: 13, padding: '10px 14px' }}
                      disabled={studyLoading}
                      autoFocus
                    />
                    <button
                      onClick={submitStudyAnswer}
                      disabled={studyLoading || !studyInput.trim()}
                      style={{ ...S.captureBtn, borderRadius: 6, opacity: studyLoading || !studyInput.trim() ? 0.5 : 1 }}
                    >
                      {studyLoading ? '...' : 'Submit'}
                    </button>
                  </div>

                  {/* Last answer feedback (structured) */}
                  {studyQueueIdx > 0 && (() => {
                    const prev = studyQueue[studyQueueIdx - 1]
                    const prevCs = studyCardState[prev.cardIdx]
                    const prevQ = prevCs.questions[prev.questionIdx]
                    const prevA = prevCs.answers[prevCs.answers.length - 1]
                    const prevResult = prevCs.results[prevCs.results.length - 1]
                    if (!prevResult) return null
                    return (
                      <div style={{
                        marginTop: 12, padding: '10px 14px', borderRadius: 6, fontSize: 12,
                        background: prevResult.correct ? 'rgba(126,231,135,.06)' : 'rgba(248,81,73,.06)',
                        border: `1px solid ${prevResult.correct ? 'rgba(126,231,135,.15)' : 'rgba(248,81,73,.15)'}`,
                      }}>
                        <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          {prevResult.correct ? '\u2713' : '\u2717'} {prevCs.front}
                        </div>
                        <div style={{ color: '#7d8590', marginBottom: 4 }}>
                          <span style={{ fontWeight: 600 }}>Q:</span> {prevQ}
                        </div>
                        <div style={{ color: '#c9d1d9', marginBottom: 6 }}>
                          <span style={{ fontWeight: 600 }}>Your answer:</span> {prevA}
                        </div>
                        <div style={{ color: prevResult.correct ? '#7ee787' : '#ffa657', lineHeight: 1.5 }}>
                          {prevResult.feedback}
                        </div>
                        {prevResult.grammarNote && (
                          <div style={{ color: '#d2a8ff', fontSize: 11, marginTop: 4, fontStyle: 'italic' }}>
                            {prevResult.grammarRelevant ? '\u26A0\uFE0F' : '\u{1F4A1}'} Grammar: {prevResult.grammarNote}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })()}

            {/* Batch feedback — show all card results */}
            {studyPhase === 'batchFeedback' && (
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3', marginBottom: 16 }}>Batch Results</div>
                {studyCardState.map((cs, ci) => {
                  const ratingColors = { easy: '#7ee787', good: '#58a6ff', hard: '#d29922', again: '#f85149' }
                  return (
                    <div key={ci} style={{ marginBottom: 16, border: '1px solid #2a3040', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{
                        padding: '8px 12px', background: '#1c2129',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>{cs.front}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: ratingColors[cs.rating] || '#7d8590' }}>
                          {cs.rating?.toUpperCase()}
                        </span>
                      </div>
                      {cs.questions.map((q, qi) => (
                        <div key={qi} style={{
                          padding: '8px 12px', borderTop: '1px solid #2a3040', fontSize: 12,
                          background: cs.results[qi]?.correct ? 'rgba(126,231,135,.03)' : 'rgba(248,81,73,.03)',
                        }}>
                          <div style={{ color: cs.results[qi]?.correct ? '#7ee787' : '#f85149', fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
                            {cs.results[qi]?.correct ? '\u2713 CORRECT' : '\u2717 INCORRECT'}
                          </div>
                          <div style={{ color: '#7d8590', marginBottom: 3 }}>
                            <span style={{ fontWeight: 600 }}>Q:</span> {q}
                          </div>
                          <div style={{ color: '#c9d1d9', marginBottom: 4 }}>
                            <span style={{ fontWeight: 600 }}>Your answer:</span> {cs.answers[qi]}
                          </div>
                          <div style={{ color: cs.results[qi]?.correct ? '#7ee787' : '#ffa657', lineHeight: 1.5, fontSize: 11 }}>
                            {cs.results[qi]?.feedback}
                          </div>
                          {cs.results[qi]?.grammarNote && (
                            <div style={{ color: '#d2a8ff', fontSize: 10, marginTop: 2, fontStyle: 'italic' }}>
                              {cs.results[qi]?.grammarRelevant ? '\u26A0\uFE0F' : '\u{1F4A1}'} Grammar: {cs.results[qi]?.grammarNote}
                            </div>
                          )}
                        </div>
                      ))}
                      <div style={{ padding: '4px 12px', borderTop: '1px solid #2a3040', fontSize: 10, color: '#484f58' }}>
                        {cs.back}
                      </div>
                    </div>
                  )
                })}
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  <button onClick={nextBatch} style={{ ...S.captureBtn, borderRadius: 6 }}>
                    {studyBatchIdx + (activeMode.studyRules?.cardsAtOnce || 3) >= studyAllCards.length ? 'Finish Session' : 'Next Batch \u2192'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      )}

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      {!studyActive && !deckBrowserActive && <main style={S.main}>
        {/* Empty state */}
        {stage === 'idle' && (
          <div style={S.emptyState}>
            <div style={{ opacity: 0.15, marginBottom: 24 }}>
              <svg width="72" height="72" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="20" height="18" rx="2" stroke="#7d8590" strokeWidth="1"/>
                <path d="M9 12l2 2 4-4" stroke="#58a6ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 style={S.emptyTitle}>Capture, paste, drop, or upload</h2>
            <p style={S.emptyDesc}>
              Hit <kbd style={S.kbdInline}>Ctrl+Shift+S</kbd> to screenshot your display,
              or paste / drag-drop any image. Tesseract.js pinpoints every word's exact
              pixel position. Your chosen AI ({providerConfig.label}) translates them.
              Hover any word on the image for translations and synonyms.
            </p>
            <div style={S.methods}>
              <div onClick={captureScreen}
                style={{ ...S.methodCard, borderColor: 'rgba(88,166,255,0.2)', cursor: 'pointer' }}>
                <span style={{ color: '#58a6ff', fontSize: 20 }}>📸</span>
                <span style={{ color: '#58a6ff' }}>Capture Screen</span>
              </div>
              <div onClick={() => fileInputRef.current?.click()}
                style={{ ...S.methodCard, borderColor: 'rgba(210,168,255,0.2)', cursor: 'pointer' }}>
                <span style={{ color: '#d2a8ff', fontSize: 20 }}>📁</span>
                <span style={{ color: '#d2a8ff' }}>Upload File</span>
              </div>
              <div style={{ ...S.methodCard, borderColor: 'rgba(126,231,135,0.2)' }}>
                <span style={{ color: '#7ee787', fontSize: 20 }}>📋</span>
                <span style={{ color: '#7ee787' }}>Ctrl+V Paste</span>
              </div>
            </div>
          </div>
        )}

        {/* Error bar */}
        {error && (() => {
          const lcErr = error.toLowerCase()
          const isCredit = /credit|balance|quota|billing|rate.limit|limit.exceeded|insufficient.funds|too.low|429|402/.test(lcErr)
          return (
            <div style={S.errorBar}>
              <div>⚠ {error}</div>
              {isCredit && (
                <div style={S.errorActions}>
                  <a href={providerConfig.billingUrl} target="_blank" rel="noopener noreferrer" style={S.errorLink}>
                    Add credits for {providerConfig.label}
                  </a>
                  <span style={{ color: '#7d8590', fontSize: 12 }}>or</span>
                  {Object.entries(PROVIDERS)
                    .filter(([key]) => key !== provider && apiKeys[key])
                    .map(([key, p]) => (
                      <button key={key} onClick={() => { setProvider(key); setError(null) }} style={{ ...S.errorSwitchBtn, color: p.color, borderColor: `${p.color}44` }}>
                        Switch to {p.label}
                      </button>
                    ))
                  }
                  {Object.entries(PROVIDERS).filter(([key]) => key !== provider && apiKeys[key]).length === 0 && (
                    <button onClick={() => setShowKeyInput(true)} style={S.errorSwitchBtn}>
                      Set up another provider
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })()}

        {/* Image + overlays */}
        {screenshot && (
          <div style={{ animation: 'fadeUp 0.25s ease', textAlign: 'center' }}>
            {/* Progress indicator */}
            {loading && (
              <div style={S.progressBar}>
                <div style={S.progressDot} />
                <span style={S.progressText}>{progress}</span>
              </div>
            )}

            {/* Image container */}
            <div
              style={S.imageContainer}
              onClick={() => stage === 'done' && ocrWords.length > 0 && setExpanded(true)}
            >
              <img src={screenshot} alt="Screenshot" style={S.mainImage} />

              {/* Word overlays */}
              {stage === 'done' && ocrWords.length > 0 && (
                <div style={S.overlayLayer}>{renderWordOverlays()}</div>
              )}

              {/* Analyze button overlay */}
              {stage === 'captured' && !loading && (
                <div style={S.capturedOverlay}>
                  <button
                    data-analyze="true"
                    onClick={(e) => { e.stopPropagation(); analyzeImage(screenshot) }}
                    style={S.bigBtn}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ marginRight: 10 }}>
                      <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                      <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    Analyze & Translate
                  </button>
                </div>
              )}

              {/* Expand hint */}
              {stage === 'done' && ocrWords.length > 0 && (
                <div style={S.hint}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Click to expand & hover words
                </div>
              )}
            </div>

            {/* Stats bar */}
            {stage === 'done' && (
              <div style={S.stats}>
                <span style={S.stat}>{ocrWords.length} words</span>
                <span style={{ ...S.stat, color: '#d2a8ff' }}>
                  {ocrWords.filter((w) => !w.isEnglish).length} {LANGS.find((l) => l.code === language)?.label}
                </span>
                <span style={{ ...S.stat, color: '#7ee787' }}>
                  {ocrWords.filter((w) => w.isEnglish).length} English
                </span>
                <span style={S.stat}>
                  avg confidence: {Math.round(ocrWords.reduce((a, w) => a + w.confidence, 0) / ocrWords.length)}%
                </span>
              </div>
            )}
          </div>
        )}
      </main>}

      {/* ── Expanded Fullscreen ───────────────────────────────────────────────── */}
      {expanded && (
        <div style={S.backdrop} onClick={() => { setExpanded(false); setHoveredIdx(null) }}>
          <div style={S.closeBadge}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span style={{ marginLeft: 6 }}>ESC to close</span>
          </div>
          <div style={S.expandedWrap} onClick={(e) => e.stopPropagation()}>
            <img src={screenshot} alt="Expanded" style={S.expandedImg} />
            <div style={S.overlayLayer}>{renderWordOverlays()}</div>
          </div>
        </div>
      )}

      {/* ── Tooltip ──────────────────────────────────────────────────────────── */}
      {activeWord && (() => {
        const hasExpanded = isPinned && (deepExplanation || wordStudy || chatMessages.length > 0)
        const hoverTransform = tooltipPos.anchor === 'below'
          ? 'translate(-50%, 0)' // tooltip below word
          : 'translate(-50%, -100%)' // tooltip above word (default)
        const tooltipStyle = isPinned
          ? { ...S.tooltip, ...S.tooltipExpanded, ...(hasExpanded ? { maxWidth: 900, width: '92vw' } : { maxWidth: 400, width: 'auto' }) }
          : { ...S.tooltip, left: tooltipPos.x, top: tooltipPos.y, transform: hoverTransform }
        return (
        <>
        {isPinned && (
          <div style={S.tooltipBackdrop} onClick={dismissPin} />
        )}
        <div style={tooltipStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={S.ttWord}>{activeWord.text}</div>
              {activeWord.pronunciation && (
                <div style={{ fontSize: 11, color: '#7d8590', fontStyle: 'italic', marginBottom: 2 }}>/{activeWord.pronunciation}/</div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {(() => {
                const posColor = POS_COLORS[activeWord.partOfSpeech] || POS_COLORS.other
                const catColor = CATEGORY_COLORS[activeWord.category]
                const showCat = activeWord.category === 'name'
                const tagColor = showCat ? catColor : posColor
                const tagLabel = showCat ? 'Name' : posColor.label
                return tagLabel ? (
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: tagColor.text, background: tagColor.bg, border: `1px solid ${tagColor.border}`, padding: '2px 6px', borderRadius: 3 }}>
                    {tagLabel}
                  </span>
                ) : null
              })()}
              {isPinned && (
                <span onClick={dismissPin} style={S.ttClose}>&times;</span>
              )}
            </div>
          </div>
          {activeWord.category === 'foreign' && (
            <div style={S.ttTrans}>→ {activeWord.translation}</div>
          )}
          {activeWord.category === 'name' && (
            <div style={{ fontSize: 11, color: '#7ee787', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Name / Proper Noun</div>
          )}
          {activeWord.category === 'target' && (
            <div style={S.ttEng}>{LANGS.find((l) => l.code === targetLang)?.label || 'Target Language'}</div>
          )}
          {activeWord.synonyms?.length > 0 && (
            <div style={S.ttSynWrap}>
              <div style={S.ttSynLabel}>Synonyms</div>
              <div style={S.ttSynList}>
                {activeWord.synonyms.map((s, i) => (
                  <span key={i} style={S.ttSynChip}>{s}</span>
                ))}
              </div>
            </div>
          )}
          <div style={S.ttConf}>OCR confidence: {Math.round(activeWord.confidence)}%</div>

          {/* Pinned: actions */}
          {isPinned && (
            <div style={S.ttActions}>
              {/* Primary button row — always visible when pinned */}
              <div style={S.ttBtnRow}>
                {!explanation && (
                  <button
                    onClick={() => autoExplain(activeWord)}
                    disabled={explaining}
                    style={{ ...S.ttDeepBtn, opacity: explaining ? 0.5 : 1 }}
                  >
                    {explaining ? 'Thinking...' : 'Explain'}
                  </button>
                )}
                {!ankiCard && !ankiSynced[activeIdx] && (
                  <button
                    onClick={() => generateAnkiCard(activeWord)}
                    disabled={ankiGenerating}
                    style={{ ...S.ttAnkiBtn, opacity: ankiGenerating ? 0.5 : 1 }}
                  >
                    {ankiGenerating ? 'Generating...' : 'Generate Anki Card'}
                  </button>
                )}
              </div>

              {/* Explanation result */}
              {explaining && !explanation && (
                <div style={S.ttExplaining}>
                  <div style={S.ttExplainingDot} />
                  Thinking...
                </div>
              )}
              {explanation && (
                <div style={S.ttExplanation}>{explanation}</div>
              )}

              {/* Secondary buttons — after explanation */}
              {explanation && (
                <div style={S.ttBtnRow}>
                  {!deepExplanation && (
                    <button
                      onClick={() => deepExplain(activeWord)}
                      disabled={deepExplaining}
                      style={{ ...S.ttDeepBtn, opacity: deepExplaining ? 0.5 : 1 }}
                    >
                      {deepExplaining ? 'Thinking...' : 'Explain further (Sonnet)'}
                    </button>
                  )}
                  {!wordStudy && (
                    <button
                      onClick={() => fetchWordStudy(activeWord)}
                      disabled={wordStudyLoading}
                      style={{ ...S.ttStudyBtn, opacity: wordStudyLoading ? 0.5 : 1 }}
                    >
                      {wordStudyLoading ? 'Loading...' : `Study "${activeWord.text}"`}
                    </button>
                  )}
                  {!conjugation && (activeWord.partOfSpeech === 'verb' || activeWord.partOfSpeech === 'noun' || activeWord.partOfSpeech === 'adj') && (
                    <button
                      onClick={() => fetchConjugation(activeWord)}
                      disabled={conjugationLoading}
                      style={{ ...S.ttDeepBtn, opacity: conjugationLoading ? 0.5 : 1, background: 'rgba(100,210,210,.12)', color: '#64d2d2', borderColor: 'rgba(100,210,210,.25)' }}
                    >
                      {conjugationLoading ? 'Loading...' : 'Conjugate'}
                    </button>
                  )}
                </div>
              )}

              {/* Anki generating spinner */}
              {ankiGenerating && (
                <div style={S.ttExplaining}>
                  <div style={S.ttExplainingDot} />
                  Generating Anki card...
                </div>
              )}

              {/* Anki card preview */}
              {ankiCard && !ankiSynced[activeIdx] && (
                <div style={S.ttAnkiCard}>
                  <div style={S.ttAnkiCardLabel}>Front</div>
                  <div style={S.ttAnkiCardContent}>{ankiCard.front}</div>
                  <div style={S.ttAnkiCardLabel}>Back</div>
                  <div style={{ ...S.ttAnkiCardContent, whiteSpace: 'pre-line', marginBottom: 4 }}>{ankiCard.back}</div>
                  {ankiCard.tags?.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={S.ttAnkiCardLabel}>Tags</div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {ankiCard.tags.map((tag, i) => (
                          <span key={i} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: 'rgba(125,133,144,.15)', color: '#c9d1d9', border: '1px solid rgba(125,133,144,.2)' }}>{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Deck:</span>
                    {ankiDecks.length > 0 ? (
                      <select
                        value={ankiDeck}
                        onChange={(e) => setAnkiDeck(e.target.value)}
                        style={{ background: '#161b22', color: '#58a6ff', border: '1px solid rgba(88,166,255,.3)', borderRadius: 4, padding: '2px 4px', fontSize: 10, fontFamily: 'inherit' }}
                      >
                        {ankiDecks.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    ) : (
                      <strong style={{ color: '#58a6ff' }}>{ankiDeck}</strong>
                    )}
                    {ankiConnected === false && <span style={{ color: '#d29922' }}>(offline)</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => syncToAnki(activeIdx)}
                      disabled={ankiSyncing || ankiConnected === false}
                      style={{ ...S.ttAnkiSyncBtn, opacity: (ankiSyncing || ankiConnected === false) ? 0.4 : 1 }}
                    >
                      {ankiSyncing ? 'Syncing...' : 'Sync to Anki'}
                    </button>
                    {ankiConnected === false && (
                      <span style={{ fontSize: 10, color: '#d29922' }}>Start Anki to sync</span>
                    )}
                  </div>
                  {ankiError && (
                    <div style={S.ttAnkiWarning}>{ankiError}</div>
                  )}
                </div>
              )}
              {ankiSynced[activeIdx] && (
                <div style={{ ...S.ttAnkiCard, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={S.ttAnkiSynced}>Synced to Anki ({ankiDeck})</span>
                </div>
              )}

              {/* Deep explanation */}
              {deepExplaining && !deepExplanation && (
                <div style={{ ...S.ttExplaining, marginTop: 8 }}>
                  <div style={S.ttExplainingDot} />
                  Sonnet is thinking...
                </div>
              )}
              {deepExplanation && (
                <div style={S.ttDeepExplanation}>{deepExplanation}</div>
              )}

              {/* Word study */}
              {wordStudyLoading && !wordStudy && (
                <div style={{ ...S.ttExplaining, marginTop: 8 }}>
                  <div style={S.ttExplainingDot} />
                  Loading word study...
                </div>
              )}
              {wordStudy && (
                <div style={S.ttWordStudy}>
                  <div style={S.ttWordStudyHeader}>
                    Word Study: {activeWord.text}
                  </div>
                  <div style={S.ttWordStudyBody}>
                    <FormattedText text={wordStudy} accentColor="#7ee787" />
                  </div>
                </div>
              )}

              {/* Conjugation */}
              {conjugationLoading && !conjugation && (
                <div style={{ ...S.ttExplaining, marginTop: 8 }}>
                  <div style={S.ttExplainingDot} />
                  Loading conjugations...
                </div>
              )}
              {conjugation && (
                <div style={{ marginTop: 8, border: '1px solid rgba(100,210,210,.2)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#64d2d2', background: 'rgba(100,210,210,.08)', padding: '8px 10px', borderBottom: '1px solid rgba(100,210,210,.15)' }}>
                    Conjugations: {activeWord.text}
                  </div>
                  <div style={{ padding: '14px 16px', background: 'rgba(100,210,210,.03)' }}>
                    <FormattedText text={conjugation} accentColor="#64d2d2" />
                  </div>
                </div>
              )}

              {/* Chat section */}
              {explanation && (
                <div style={S.ttChatSection}>
                  <div style={S.ttChatLabel}>Ask about this word</div>
                  {chatMessages.map((m, i) => (
                    <div key={i} style={m.role === 'user' ? S.ttChatUser : S.ttChatAssistant}>
                      {m.text}
                    </div>
                  ))}
                  {chatLoading && (
                    <div style={{ ...S.ttExplaining, marginTop: 4 }}>
                      <div style={S.ttExplainingDot} />
                      Typing...
                    </div>
                  )}
                  <div style={S.ttChatInputRow}>
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendChat(activeWord) }}
                      placeholder="e.g. How do I conjugate this?"
                      style={S.ttChatInput}
                    />
                    <button
                      onClick={() => sendChat(activeWord)}
                      disabled={chatLoading || !chatInput.trim()}
                      style={{ ...S.ttChatSend, opacity: chatLoading || !chatInput.trim() ? 0.4 : 1 }}
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isPinned && (
            <div style={S.ttClickHint}>Click to pin & explore</div>
          )}
        </div>
        </>
        )
      })()}

      {/* ── Global Styles ────────────────────────────────────────────────────── */}
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.6); opacity: 0; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

