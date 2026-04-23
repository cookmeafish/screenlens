import { useState, useRef, useCallback, useEffect } from 'react'
import Tesseract from 'tesseract.js'
import { TRANSLATE_PROMPT, POS_COLORS, CATEGORY_COLORS } from './config/prompts'
import { PROVIDERS } from './config/providers'
import { LANGS } from './config/languages'
import FormattedText from './components/FormattedText'
import HelpChat from './components/HelpChat'
import { S } from './styles/theme'
import { ocrLog, ocrLogTable, ocrLogFlush } from './utils/logger'
import { ankiPing, ankiGetDecks, ankiCreateDeck, ankiAddNote, ankiFindCards, ankiCardsInfo, ankiAnswerCards, ankiGetDeckStats, ankiFindNotes, ankiNotesInfo, ankiUpdateNote, ankiDeleteNotes, ankiSync } from './utils/anki'


// ─── Image Preprocessing for OCR ────────────────────────────────────────────
// Creates a high-contrast grayscale version optimized for Tesseract
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
      const pixelCount = d.length / 4

      // Step 1: Convert to grayscale
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = d[i + 1] = d[i + 2] = gray
      }

      // Step 2: Detect brightness
      let totalBrightness = 0
      for (let i = 0; i < d.length; i += 4) totalBrightness += d[i]
      const avgBrightness = totalBrightness / pixelCount
      const isDark = avgBrightness < 128

      // Step 3: Moderate contrast enhancement (1.8x — 2.5 was crushing details)
      const factor = 1.8
      for (let i = 0; i < d.length; i += 4) {
        const val = (d[i] - 128) * factor + 128
        d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, val))
      }

      // Step 4: If dark background, invert (Tesseract prefers dark text on white)
      if (isDark) {
        for (let i = 0; i < d.length; i += 4) {
          d[i] = d[i + 1] = d[i + 2] = 255 - d[i]
        }
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

  // Make body transparent for overlay mode so clip-path/transparent bg works
  useEffect(() => {
    if (!isOverlay) return
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [isOverlay])

  // ESC hides overlay — Electron handles the actual window hiding via global shortcut
  // This just resets the web app state so it's ready for the next capture
  useEffect(() => {
    if (!isOverlay) return
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', handleEsc, true)
    return () => window.removeEventListener('keydown', handleEsc, true)
  }, [isOverlay])
  const [activeTab, setActiveTab] = useState(null) // 'chat' | 'study' | 'picture' | 'stats' — null until config loads
  const [chatSidePanel, setChatSidePanel] = useState(false) // split-screen chat alongside another tab
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
  const [pinnedTooltipPos, setPinnedTooltipPos] = useState(() => {
    try { const s = localStorage.getItem('screenlens-tooltip-pos'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const tooltipDragRef = useRef(null)
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
  const [selectionMode, setSelectionMode] = useState(false)
  const [selRect, setSelRect] = useState(null) // { x1, y1, x2, y2 } in viewport coords
  const [selectionOffset, setSelectionOffset] = useState(null) // { x, y } in full-image pixels
  const [selectionViewport, setSelectionViewport] = useState(null) // { x, y, w, h } in viewport px
  const [selectionCrop, setSelectionCrop] = useState(null) // { dataUrl, w, h } for transparent mode
  const [areaSelectBounds, setAreaSelectBounds] = useState(null) // original small window bounds to restore on dismiss
  const selStartRef = useRef(null)
  const [ankiConnected, setAnkiConnected] = useState(null)
  const [ankiDecks, setAnkiDecks] = useState([])
  const [ankiCard, setAnkiCard] = useState(null)
  const [ankiSynced, setAnkiSynced] = useState({})
  const [ankiSyncing, setAnkiSyncing] = useState(false)
  const [ankiError, setAnkiError] = useState(null)
  const [ankiGenerating, setAnkiGenerating] = useState(false)
  const [ankiEditing, setAnkiEditing] = useState(false)
  const [ankiEditFront, setAnkiEditFront] = useState('')
  const [ankiEditBack, setAnkiEditBack] = useState('')
  const [ankiRefineInput, setAnkiRefineInput] = useState('')
  const [ankiRefining, setAnkiRefining] = useState(false)
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
    id: 1, name: 'Language Learning', type: 'language', description: '', ankiDeck: '', translateMode: 'all', areaSelectTransparent: true,
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
  const [deckBrowserRefineInput, setDeckBrowserRefineInput] = useState('')
  const [deckBrowserRefining, setDeckBrowserRefining] = useState(false)
  const [deckBrowserSaveStatus, setDeckBrowserSaveStatus] = useState(null) // null | 'saving' | 'saved' | 'error'
  const [studyWrappingUp, setStudyWrappingUp] = useState(false)
  const [studyDeleteConfirm, setStudyDeleteConfirm] = useState(null) // cardIdx being confirmed for deletion
  const [studyFeedbackChat, setStudyFeedbackChat] = useState({}) // { [cardIdx]: { messages, input, loading } }
  const [studyCurrentHint, setStudyCurrentHint] = useState(null) // hint text for current question
  const [studyHintLevel, setStudyHintLevel] = useState(0) // 0=none, 1=hint1 shown, 2=hint2 shown
  const [studyAnswerHistory, setStudyAnswerHistory] = useState([]) // [{cardIdx, questionIdx}] for undo
  const [studyInsights, setStudyInsights] = useState(null)
  const [studyInsightsLoading, setStudyInsightsLoading] = useState(false)
  const [studySyncNotification, setStudySyncNotification] = useState(false)

  // ─── Chat Tab State ───────────────────────────────────────────────────────
  const [chatTabMsgs, setChatTabMsgs] = useState([]) // [{ role, content, cards? }]
  const [chatTabInput, setChatTabInput] = useState('')
  const [chatTabLoading, setChatTabLoading] = useState(false)
  const [chatTabAttachedDeck, setChatTabAttachedDeck] = useState(null) // { name, cards, progress }
  const [chatTabAttachLoading, setChatTabAttachLoading] = useState(false)
  const [chatTabSessions, setChatTabSessions] = useState([])
  const [chatTabSessionId, setChatTabSessionId] = useState(null)
  const [chatTabEditingTitle, setChatTabEditingTitle] = useState(null)
  const [chatTabWebSearch, setChatTabWebSearch] = useState(false)
  const [chatTabStatus, setChatTabStatus] = useState(null) // null | 'searching' | 'thinking' | 'search-done' | 'search-empty' | 'search-failed'
  const chatTabScrollRef = useRef(null)

  // Load chat sessions from disk on mount
  useEffect(() => {
    fetch('/api/chats').then(r => r.json()).then(sessions => {
      setChatTabSessions(sessions)
    }).catch(() => {})
  }, [])

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
  const cancelRef = useRef(false)

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
      setActiveTab(config.activeTab || 'picture')
      // ankiDeck is now per-mode (stored in mode config)
      setKeysLoaded(true)
      setConfigLoaded(true)
    })
    // Check overlay status immediately and poll
    const checkOverlay = () => fetch('/api/launch-overlay').then(r => r.json()).then(d => setOverlayRunning(d.running)).catch(() => {})
    checkOverlay()
    const overlayPoll = setInterval(checkOverlay, 3000)

    // Overlay mode: load screenshot from Electron capture
    const loadOverlayScreenshot = (onLoaded) => {
      const url = window.__overlayScreenshot
      if (!url) return
      fetch(url).then(r => r.blob()).then(blob => {
        const reader = new FileReader()
        reader.onload = (e) => {
          const dataUrl = e.target.result
          const img = new Image()
          img.onload = () => {
            setImgDims({ w: img.naturalWidth, h: img.naturalHeight })
            setScreenshot(dataUrl)
            setStage('captured')
            setOcrWords([])
            setError(null)
            // Reveal page now that new screenshot is rendered
            document.body.style.opacity = '1'
            onLoaded(dataUrl)
          }
          img.src = dataUrl
        }
        reader.readAsDataURL(blob)
      }).catch(err => console.error('[Overlay] Failed to load screenshot:', err))
    }

    // Full-screen capture (Ctrl+Shift+S)
    const handleOverlayCapture = () => {
      console.log('[Overlay] Full capture')
      window.__selectionMode = false
      setSelectionMode(false)
      setSelectionOffset(null)
      setSelectionViewport(null)
      setSelectionCrop(null)
      loadOverlayScreenshot((dataUrl) => {
        setTimeout(() => { window.__autoAnalyze = dataUrl }, 100)
      })
    }
    window.addEventListener('overlay-capture', handleOverlayCapture)

    // Area-select: selector window already captured, we receive the rect + screenshot
    const handleAreaCaptured = async () => {
      const rect = window.__areaSelectRect
      const url = window.__overlayScreenshot
      if (!rect || !url) return
      window.__areaSelectRect = null
      console.log('[Overlay] Area captured:', rect)

      try {
        const resp = await fetch(url)
        const blob = await resp.blob()
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = (e) => resolve(e.target.result)
          reader.readAsDataURL(blob)
        })
        const img = await new Promise((resolve) => {
          const i = new window.Image()
          i.onload = () => resolve(i)
          i.src = dataUrl
        })

        // Use screen dimensions (not window.innerWidth which is now the small window)
        const scaleX = img.naturalWidth / rect.screenW
        const scaleY = img.naturalHeight / rect.screenH
        const cx = Math.round(rect.x * scaleX)
        const cy = Math.round(rect.y * scaleY)
        const cw = Math.round(rect.w * scaleX)
        const ch = Math.round(rect.h * scaleY)

        const canvas = document.createElement('canvas')
        canvas.width = cw
        canvas.height = ch
        canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch)
        const croppedDataUrl = canvas.toDataURL('image/png')

        const pad = rect.pad || 6
        // Window is sized to selection — render crop at (0,0) with padding
        setImgDims({ w: cw, h: ch })
        setScreenshot(croppedDataUrl)
        setSelectionOffset(null) // no offset needed — crop IS the image
        setSelectionViewport(null) // no viewport positioning — window IS the selection
        setSelectionCrop(null) // not using the separate crop rendering path
        setStage('captured')
        setOcrWords([])
        setError(null)
        setSelectionMode(false)
        window.__selectionMode = false
        // Save the small window bounds so we can restore after tooltip dismiss
        setAreaSelectBounds({ x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight })
        document.body.style.opacity = '1'
        setTimeout(() => { window.__autoAnalyze = croppedDataUrl }, 100)
      } catch (err) {
        console.error('[Overlay] Area capture failed:', err)
        document.body.style.opacity = '1'
      }
    }
    window.addEventListener('overlay-area-captured', handleAreaCaptured)

    // Overlay reset: clear old screenshot before new capture to prevent flash
    const handleOverlayReset = () => {
      setScreenshot(null)
      setStage('idle')
      setOcrWords([])
      window.__selectionMode = false
      setSelectionMode(false)
      setSelRect(null)
      setSelectionOffset(null)
      setSelectionViewport(null)
      setSelectionCrop(null)
      setAreaSelectBounds(null)
    }
    window.addEventListener('overlay-reset', handleOverlayReset)

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
      body: JSON.stringify({ provider, language, targetLang, showHighlights, ...(activeTab ? { activeTab } : {}) }),
    }).catch(() => {})
  }, [provider, language, targetLang, showHighlights, activeTab, configLoaded])

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

  // ─── Area Selection (Ctrl+Shift+A) ──────────────────────────────────────────
  const selRectRef = useRef(null)
  const screenshotRef = useRef(screenshot)
  screenshotRef.current = screenshot

  const handleSelectionDown = useCallback((e) => {
    e.preventDefault()
    const rect = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }
    selStartRef.current = { x: e.clientX, y: e.clientY }
    selRectRef.current = rect
    setSelRect(rect)
  }, [])

  const handleSelectionMove = useCallback((e) => {
    if (!selStartRef.current) return
    e.preventDefault()
    const updated = { ...selRectRef.current, x2: e.clientX, y2: e.clientY }
    selRectRef.current = updated
    setSelRect(updated)
  }, [])

  const handleSelectionUp = useCallback(async () => {
    if (!selStartRef.current) return
    selStartRef.current = null
    const r = selRectRef.current
    if (!r) return
    const x = Math.min(r.x1, r.x2)
    const y = Math.min(r.y1, r.y2)
    const w = Math.abs(r.x2 - r.x1)
    const h = Math.abs(r.y2 - r.y1)
    if (w < 10 || h < 10) return // too small, ignore

    // Hide drawing UI immediately
    window.__selectionMode = false
    setSelectionMode(false)
    setSelRect(null)
    selRectRef.current = null

    // Hide overlay so we capture the actual screen, not the overlay
    document.body.style.opacity = '0'
    await new Promise(resolve => setTimeout(resolve, 50))

    // Capture screenshot now via Electron IPC (or via fetch for non-Electron)
    let screenshotUrl
    if (window.overlayAPI?.captureScreenshot) {
      screenshotUrl = await window.overlayAPI.captureScreenshot()
    }
    if (!screenshotUrl) { document.body.style.opacity = '1'; return }

    // Load the full screenshot, crop to selection, show only the crop
    try {
      const resp = await fetch(screenshotUrl)
      const blob = await resp.blob()
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target.result)
        reader.readAsDataURL(blob)
      })
      const img = await new Promise((resolve) => {
        const i = new window.Image()
        i.onload = () => resolve(i)
        i.src = dataUrl
      })

      const scaleX = img.naturalWidth / window.innerWidth
      const scaleY = img.naturalHeight / window.innerHeight
      const cx = Math.round(x * scaleX)
      const cy = Math.round(y * scaleY)
      const cw = Math.round(w * scaleX)
      const ch = Math.round(h * scaleY)

      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch)
      const croppedDataUrl = canvas.toDataURL('image/png')

      // Store full screenshot for non-transparent mode fallback
      setImgDims({ w: img.naturalWidth, h: img.naturalHeight })
      setScreenshot(dataUrl)
      setSelectionOffset({ x: cx, y: cy })
      setSelectionViewport({ x, y, w, h })
      setSelectionCrop({ dataUrl: croppedDataUrl, w: cw, h: ch })
      setStage('captured')
      setOcrWords([])
      setError(null)
      document.body.style.opacity = '1'
      // Auto-analyze the cropped region
      setTimeout(() => { window.__autoAnalyze = croppedDataUrl }, 100)
    } catch (err) {
      console.error('[Overlay] Area-select capture failed:', err)
      document.body.style.opacity = '1'
    }
  }, [])

  // ─── Analysis Pipeline ──────────────────────────────────────────────────────
  const analyzeImage = useCallback(async (dataUrl) => {
    if (!dataUrl) return
    if (!apiKey) {
      setShowKeyInput(true)
      setError(`Set your ${providerConfig.label} API key first.`)
      return
    }

    cancelRef.current = false
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

      // Downscale for OCR only if extremely wide (4K+) — keep detail for better detection
      let ocrInput = dataUrl
      if (realW > 3000) {
        const scale = 2560 / realW
        const c = document.createElement('canvas')
        c.width = 2560
        c.height = Math.round(realH * scale)
        const ctx = c.getContext('2d')
        const img = new Image()
        await new Promise((resolve) => { img.onload = resolve; img.src = dataUrl })
        ctx.drawImage(img, 0, 0, c.width, c.height)
        ocrInput = c.toDataURL('image/png')
      }

      // Dual-pass OCR with cancel support
      setProgress('Preprocessing…')
      const preprocessed = await preprocessForOCR(ocrInput)
      if (cancelRef.current) return

      const ocrLang = language === 'auto' ? 'eng+spa+fra+deu+por+ita' : language

      // Helper to merge non-overlapping words
      const mergeWords = (existing, newWords) => {
        for (const w2 of newWords) {
          const overlaps = existing.some((w1) => {
            const ox = Math.max(0, Math.min(w1.bbox.x1, w2.bbox.x1) - Math.max(w1.bbox.x0, w2.bbox.x0))
            const oy = Math.max(0, Math.min(w1.bbox.y1, w2.bbox.y1) - Math.max(w1.bbox.y0, w2.bbox.y0))
            const area2 = (w2.bbox.x1 - w2.bbox.x0) * (w2.bbox.y1 - w2.bbox.y0)
            return area2 > 0 && (ox * oy) / area2 > 0.3
          })
          if (!overlaps) existing.push(w2)
        }
      }

      // Pass 1: Preprocessed (high contrast)
      setProgress('OCR pass 1…')
      const r1 = await Tesseract.recognize(preprocessed, ocrLang, {
        logger: (m) => { if (m.status === 'recognizing text') setProgress(`OCR 1: ${Math.round((m.progress || 0) * 100)}%`) },
      })
      if (cancelRef.current) return

      // Pass 2: Original image
      setProgress('OCR pass 2…')
      const r2 = await Tesseract.recognize(ocrInput, ocrLang, {
        logger: (m) => { if (m.status === 'recognizing text') setProgress(`OCR 2: ${Math.round((m.progress || 0) * 100)}%`) },
      })
      if (cancelRef.current) return

      // Merge all passes
      const merged = [...(r1.data.words || [])]
      mergeWords(merged, r2.data.words || [])

      ocrLog(`OCR pass 1: ${(r1.data.words||[]).length}, pass 2: ${(r2.data.words||[]).length}, merged: ${merged.length}`)

      // Scale bounding boxes back to original resolution if we downscaled
      const bboxScale = realW > 3000 ? realW / 2560 : 1

      // ── Log: Raw Tesseract output ──
      const allTessWords = merged
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
          const minConf = cleaned.length <= 2 ? 65 : cleaned.length <= 3 ? 45 : 35
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
      if (cancelRef.current) return

      // In "click" mode, skip batch translation — words get translated on click
      if (activeMode.translateMode === 'click') {
        const mapped = finalWords.map((w, idx) => ({
          ...w, _untranslated: true, translation: '', synonyms: [], category: 'foreign',
          partOfSpeech: '', pronunciation: '', isEnglish: false, _globalIdx: idx,
        }))
        setOcrWords(mapped)
        setStage('done')
        setLoading(false)
        ocrLog(`Click-to-translate mode: ${mapped.length} words ready, skipping batch translation`)
        ocrLogFlush()
        return
      }

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
        if (loading) {
          // Cancel ongoing analysis
          cancelRef.current = true
          setLoading(false)
          setStage(screenshot ? 'captured' : 'idle')
          setProgress('')
        } else if (pinnedIdx !== null) {
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

  // ─── Save study stats to history when session reaches summary ────────────
  useEffect(() => {
    if (studyPhase !== 'summary' || !studyDeck) return
    const totalCards = studyStats.easy + studyStats.good + studyStats.hard + studyStats.again
    if (totalCards === 0) return
    const totalQuestions = studyCardState.reduce((s, cs) => s + (cs.results?.length || 0), 0)
    const correctQuestions = studyCardState.reduce((s, cs) => s + (cs.results?.filter(r => r.correct).length || 0), 0)
    const entry = {
      date: new Date().toISOString().split('T')[0],
      deck: studyDeck,
      mode: activeMode.name,
      cardsStudied: totalCards,
      accuracy: totalQuestions > 0 ? Math.round(correctQuestions / totalQuestions * 100) : 0,
      correct: correctQuestions,
      totalQuestions,
      ratings: { ...studyStats },
    }
    try {
      const history = JSON.parse(localStorage.getItem('screenlens-study-history') || '[]')
      history.unshift(entry)
      localStorage.setItem('screenlens-study-history', JSON.stringify(history.slice(0, 500)))
      console.log('[Stats] saved session:', entry)
    } catch {}
  }, [studyPhase, studyStats, studyCardState, studyDeck])

  // ─── Overlay auto-analyze ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOverlay) return
    const interval = setInterval(() => {
      if (window.__autoAnalyze && stage === 'captured' && !window.__selectionMode) {
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
    const vw = window.innerWidth
    const ttHalf = 160 // ~half of tooltip maxWidth (300/2 + margin)
    let x = rect.left + rect.width / 2
    let y = rect.top - 6
    let anchor = 'above'
    // If not enough room above the word, show below
    if (rect.top < 180) {
      y = rect.bottom + 6
      anchor = 'below'
    }
    // Clamp horizontal so tooltip doesn't clip left/right edges
    x = Math.max(ttHalf, Math.min(vw - ttHalf, x))
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
      setAnkiCard(null); setAnkiError(null); setAnkiEditing(false); setAnkiRefineInput('')
      setChatMessages([])
      setChatInput('')
      const rect = e.currentTarget.getBoundingClientRect()
      setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top - 6 })
      // In area-select overlay (small window), expand to full screen so tooltip has room
      if (isOverlay && areaSelectBounds && window.overlayAPI?.resizeWindow) {
        window.overlayAPI.resizeWindow({ x: 0, y: 0, width: screen.width, height: screen.height })
        // Default tooltip position: to the right of the selection area, or use saved pos
        if (!pinnedTooltipPos) {
          const selRight = areaSelectBounds.x + areaSelectBounds.width
          setPinnedTooltipPos({
            x: selRight + 20 < screen.width - 400 ? selRight + 20 : Math.max(10, areaSelectBounds.x - 420),
            y: areaSelectBounds.y,
          })
        }
      } else if (!pinnedTooltipPos) {
        setPinnedTooltipPos({ x: Math.max(10, rect.left - 100), y: Math.max(10, rect.bottom + 10) })
      }
      // Lazy translate if in click mode and word hasn't been translated yet
      if (ocrWords[idx]?._untranslated) lazyTranslate(idx)
    }
  }

  const dismissPin = () => {
    setPinnedIdx(null)
    setExplanation(null)
    setDeepExplanation(null)
    setWordStudy(null); setConjugation(null)
    setAnkiCard(null); setAnkiError(null); setAnkiEditing(false); setAnkiRefineInput('')
    setChatMessages([])
    setChatInput('')
    setHoveredIdx(null)
    // In area-select overlay, shrink window back to selection bounds
    if (isOverlay && areaSelectBounds && window.overlayAPI?.resizeWindow) {
      window.overlayAPI.resizeWindow(areaSelectBounds)
    }
  }

  // ─── Draggable pinned tooltip ─────────────────────────────────────────────
  const handleTooltipDragStart = (e) => {
    e.preventDefault()
    const el = e.currentTarget.closest('[data-tooltip-pinned]')
    if (!el) return
    const rect = el.getBoundingClientRect()
    tooltipDragRef.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
    const onMove = (ev) => {
      if (!tooltipDragRef.current) return
      const x = ev.clientX - tooltipDragRef.current.offsetX
      const y = ev.clientY - tooltipDragRef.current.offsetY
      setPinnedTooltipPos({ x, y })
    }
    const onUp = () => {
      tooltipDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Save position
      setPinnedTooltipPos(prev => {
        if (prev) localStorage.setItem('screenlens-tooltip-pos', JSON.stringify(prev))
        return prev
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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
    setAnkiEditing(false)
    setAnkiRefineInput('')
    // Re-check Anki connection so the status is fresh (user may have opened Anki since last check)
    const connected = await ankiPing()
    setAnkiConnected(connected)
    if (connected) {
      const decks = await ankiGetDecks().catch(() => [])
      setAnkiDecks(decks)
    }
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

  const refineAnkiCard = async () => {
    const instruction = ankiRefineInput.trim()
    if (!instruction || !ankiCard || !apiKey || ankiRefining) return
    setAnkiRefining(true)
    setAnkiError(null)
    try {
      const prompt = `Here is an Anki flashcard:

FRONT:
${ankiCard.front}

BACK:
${ankiCard.back}

TAGS: ${(ankiCard.tags || []).join(', ')}

The user wants this change: "${instruction}"

Return a JSON object with the updated card: { "front": "...", "back": "...", "tags": [...] }
Keep any fields the user didn't ask to change. Output ONLY raw JSON, no markdown or backticks.`

      const text = await providerConfig.call(apiKey, 'You edit Anki flashcard content. Always respond with valid JSON only.', prompt)
      const updated = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
      setAnkiCard({
        front: updated.front || ankiCard.front,
        back: updated.back || ankiCard.back,
        tags: Array.isArray(updated.tags) ? updated.tags : ankiCard.tags,
      })
      setAnkiRefineInput('')
    } catch (err) {
      setAnkiError('Refine failed: ' + err.message)
    } finally {
      setAnkiRefining(false)
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
    setDeckBrowserRefineInput('')
  }

  const saveEditNote = async (noteId) => {
    // Convert newlines back to <br> for Anki
    const htmlFields = {}
    Object.entries(deckBrowserEditFields).forEach(([name, val]) => {
      htmlFields[name] = val.replace(/\n/g, '<br>')
    })
    setDeckBrowserSaveStatus('saving')
    try {
      await ankiUpdateNote(noteId, htmlFields)
      ankiSync().catch(() => {})
      // Reload
      await loadDeckNotes(deckBrowserDeck)
      setDeckBrowserEditing(null)
      setDeckBrowserSaveStatus('saved')
      setTimeout(() => setDeckBrowserSaveStatus(null), 2000)
      console.log('[Deck] note updated:', noteId)
    } catch (err) {
      setDeckBrowserSaveStatus('error')
      console.error('[Deck] update failed:', err.message)
    }
  }

  const refineDeckBrowserCard = async () => {
    const instruction = deckBrowserRefineInput.trim()
    if (!instruction || !apiKey || deckBrowserRefining || !deckBrowserEditing) return
    setDeckBrowserRefining(true)
    try {
      const fieldsDesc = Object.entries(deckBrowserEditFields).map(([name, val]) => `${name}:\n${val}`).join('\n\n')
      const prompt = `Here is an Anki flashcard:\n\n${fieldsDesc}\n\nThe user wants this change: "${instruction}"\n\nReturn a JSON object with the updated fields: { ${Object.keys(deckBrowserEditFields).map(k => `"${k}": "..."`).join(', ')} }\nKeep any fields the user didn't ask to change. Output ONLY raw JSON, no markdown or backticks.`

      const text = await providerConfig.call(apiKey, 'You edit Anki flashcard content. Always respond with valid JSON only.', prompt)
      const updated = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
      const newFields = { ...deckBrowserEditFields }
      Object.entries(updated).forEach(([k, v]) => { if (k in newFields) newFields[k] = String(v) })
      setDeckBrowserEditFields(newFields)
      setDeckBrowserRefineInput('')
    } catch (err) {
      console.error('[Deck] refine failed:', err.message)
    } finally {
      setDeckBrowserRefining(false)
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
    // Sync any edited notes back into the active study session
    if (deckBrowserNotes.length > 0 && studyAllCards.length > 0) {
      const noteMap = {}
      deckBrowserNotes.forEach(n => { noteMap[n.noteId] = n })
      const updatedAllCards = studyAllCards.map(card => {
        const updatedNote = noteMap[card.note]
        return updatedNote ? { ...card, fields: updatedNote.fields } : card
      })
      setStudyAllCards(updatedAllCards)
      setStudyCardState(prev => prev.map(cs => {
        const card = updatedAllCards.find(c => c.cardId === cs.cardId)
        if (!card || !noteMap[card.note]) return cs
        return { ...cs, front: getCardFront(card), back: getCardBack(card) }
      }))
    }
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
  const generateQuestionsForCard = async (card, rules, studyLang, knowledgeContext) => {
    const front = getCardFront(card)
    const back = getCardBack(card)
    const n = rules.questionsPerCard || 3
    const questionPrompt = rules.questionPrompt || defaultStudyRules.questionPrompt

    const orderRules = n === 1
      ? `Generate 1 question. It must be BLIND RECALL — never mention the target word/answer.`
      : [
          `Generate exactly ${n} questions in this STRICT ORDER:`,
          `Q1 (BLIND RECALL): Never name or hint at the target word/answer. Present a scenario, definition, or usage context that forces the student to produce the exact word. Example: "You need to X in situation Y — what word/tool/concept applies?"`,
          n >= 3 ? `Q2–Q${n - 1} (GUIDED RECALL): May reference related concepts, synonyms as contrast, or fill-in-the-blank. Must still require the EXACT target word. E.g. "Instead of [synonym], what [N]-letter word means...?" Each from a DIFFERENT angle.` : null,
          `Q${n} (DEEP UNDERSTANDING): May freely name the subject. Test HOW, WHY, WHEN, or process. E.g. "Explain how X works" or "What distinguishes X from Y?" Open-ended — student demonstrates conceptual depth.`,
        ].filter(Boolean).join('\n')

    const prompt = `Card front: "${front}"\nCard back: "${back}"\n\n${orderRules}\n\nCRITICAL RULES:\n- Questions must require the SPECIFIC answer on this card — synonyms are NOT acceptable for recall/fill_blank questions\n- NEVER construct a question whose only purpose is to directly name the answer (e.g. "what noun corresponds to adjective X?" when that noun IS the answer)\n- Each question must test a DIFFERENT angle\n- For language cards: test usage in sentences, grammatical properties, contextual usage\n- For conceptual cards: test application, process, comparison\n\n${questionPrompt}\n\nGenerate all questions in ${studyLang}.${knowledgeContext}\n\nReturn a JSON array of exactly ${n} objects:\n[\n  {\n    "question": "the question text",\n    "type": "recall" | "fill_blank" | "explanation",\n    "hint1": "N letters" (letter count of primary answer, null for explanation),\n    "hint2": "starts with 'X'" (first letter of primary answer, null for explanation),\n    "acceptedAnswers": ["answer1", "answer2"] (lowercase; exact words that are correct; empty for explanation)\n  }\n]\nOutput ONLY raw JSON array. No markdown, no backticks.`

    try {
      const text = await providerConfig.call(apiKey, 'You generate structured flashcard quiz questions. Always respond with a valid JSON array of objects.', prompt)
      const parsed = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))
      if (!Array.isArray(parsed)) throw new Error('not array')
      return parsed.slice(0, n).map(q => ({
        question: typeof q === 'string' ? q : (q.question || ''),
        type: q.type || 'recall',
        hint1: q.hint1 || null,
        hint2: q.hint2 || null,
        acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers.map(a => String(a).toLowerCase().trim()) : [],
      }))
    } catch {
      const fallback = [
        { question: `What concept relates to: ${back.slice(0, 30)}...?`, type: 'recall', hint1: `${back.split(/\s+/)[0].length} letters`, hint2: `starts with '${back[0]?.toUpperCase() || '?'}'`, acceptedAnswers: [back.toLowerCase().trim()] },
        { question: `Explain this in your own words.`, type: 'explanation', hint1: null, hint2: null, acceptedAnswers: [] },
        { question: `Why is this important?`, type: 'explanation', hint1: null, hint2: null, acceptedAnswers: [] },
      ]
      return fallback.slice(0, n)
    }
  }

  // Extracts question text whether question is a string (legacy) or object {question, type, ...}
  const getQuestionText = (q) => (typeof q === 'string' ? q : q?.question || '')

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

      const knowledgeRes = await fetch(`/api/modes/knowledge?mode=${encodeURIComponent(activeMode.name)}`).then(r => r.json()).catch(() => ({ content: null, fileCount: 0 }))
      setStudyKnowledge(knowledgeRes.content)
      setStudyKnowledgeCount(knowledgeRes.fileCount || 0)

      const stats = await ankiGetDeckStats([deck]).catch(() => ({}))
      const deckStat = Object.values(stats)[0] || { new_count: 0, learn_count: 0, review_count: 0 }
      setStudyDeckStats(deckStat)

      const shuffled = [...cardIds].sort(() => Math.random() - 0.5)
      const cards = await ankiCardsInfo(shuffled.slice(0, 100))
      console.log('[Study] loaded', cards.length, 'cards from deck:', deck)
      setStudyAllCards(cards)
      setStudyStats({ easy: 0, good: 0, hard: 0, again: 0 })

      const rules = activeMode.studyRules || (activeMode.type === 'language' ? defaultStudyRules : defaultGeneralStudyRules)
      const cardsAtOnce = 10
      const studyLang = rules.studyLanguage || 'English'
      const knowledgeContext = knowledgeRes.content ? `\n\nReference material:\n${knowledgeRes.content.substring(0, 4000)}\n\nUse this context to create more specific, contextual questions.` : ''

      // Generate first card only, then start immediately
      const firstCard = cards[0]
      const firstQuestions = await generateQuestionsForCard(firstCard, rules, studyLang, knowledgeContext)
      const firstCardState = {
        cardId: firstCard.cardId, front: getCardFront(firstCard), back: getCardBack(firstCard),
        questions: firstQuestions, answers: [], results: [], done: false, questionIdx: 0, questionAttempts: [],
      }

      console.log('[Study] started with first card, generating rest in background')
      setStudyCardState([firstCardState])
      setStudyBatchIdx(cardsAtOnce) // pullNewCard starts at index 10+
      setStudyQueue([])
      setStudyQueueIdx(0)
      setStudyInput('')
      setStudyLoading(false)
      setStudyPhase('question')

      // Background: generate cards 1..9 and append as ready
      ;(async () => {
        const backgroundCards = cards.slice(1, cardsAtOnce)
        for (const card of backgroundCards) {
          if (studyWrappingUpRef.current) {
            setStudyCardState(prev => [...prev, {
              cardId: card.cardId, front: getCardFront(card), back: getCardBack(card),
              questions: [], answers: [], results: [], done: true, skipped: true, questionIdx: 0,
            }])
            continue
          }
          const questions = await generateQuestionsForCard(card, rules, studyLang, knowledgeContext)
          if (studyWrappingUpRef.current) continue
          setStudyCardState(prev => [...prev, {
            cardId: card.cardId, front: getCardFront(card), back: getCardBack(card),
            questions, answers: [], results: [], done: false, questionIdx: 0, questionAttempts: [],
          }])
        }
      })()
    } catch (err) {
      console.error('[Study] failed to start:', err.message)
      setAnkiError('Study failed: ' + err.message)
      setStudyLoading(false)
    }
  }

  const lastAskedCardRef = useRef(null)
  const studyWrappingUpRef = useRef(false)

  // Pick a random active (not done) card — avoid same card twice in a row
  const getNextStudyQuestion = () => {
    const activeCards = studyCardState.map((cs, i) => ({ cs, i })).filter(({ cs }) => !cs.done && cs.questionIdx < cs.questions.length)
    if (activeCards.length === 0) return null
    // Exclude last asked card unless it's the only one
    let candidates = activeCards.filter(({ i }) => i !== lastAskedCardRef.current)
    if (candidates.length === 0) candidates = activeCards
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    lastAskedCardRef.current = pick.i
    return { cardIdx: pick.i, questionIdx: pick.cs.questionIdx }
  }

  const [currentQuestion, setCurrentQuestion] = useState(null)

  // Pick first question when entering question phase
  useEffect(() => {
    if (studyPhase === 'question' && !currentQuestion && studyCardState.length > 0) {
      setCurrentQuestion(getNextStudyQuestion())
    }
  }, [studyPhase, studyCardState])

  const submitStudyAnswer = async () => {
    if (!studyInput.trim() || studyLoading || !currentQuestion) return
    const answer = studyInput.trim()
    const { cardIdx, questionIdx } = currentQuestion
    const cs = studyCardState[cardIdx]
    const questionObj = cs.questions[questionIdx]
    const qpc = (activeMode.studyRules || defaultStudyRules).questionsPerCard || 3
    const isExplanation = questionObj?.type === 'explanation'
    const acceptedAnswers = questionObj?.acceptedAnswers || []

    // Track this attempt in questionAttempts
    const prevAttempts = cs.questionAttempts?.[questionIdx] || []
    const allAttempts = [...prevAttempts, answer]

    // Check correctness for non-explanation questions with acceptedAnswers
    const normalize = (s) => s.toLowerCase().trim().replace(/[.!?,;:]/g, '').replace(/\s+/g, ' ')
    const isCorrect = !isExplanation && acceptedAnswers.length > 0 &&
      acceptedAnswers.some(a => normalize(a) === normalize(answer))

    const newStates = [...studyCardState]
    const newAttempts = [...(cs.questionAttempts || [])]
    newAttempts[questionIdx] = allAttempts
    newStates[cardIdx] = { ...cs, questionAttempts: newAttempts }

    // If wrong on a hintable question and hints remain — show hint, stay on question
    if (!isExplanation && acceptedAnswers.length > 0 && !isCorrect && studyHintLevel < 2) {
      const newLevel = studyHintLevel + 1
      setStudyHintLevel(newLevel)
      setStudyCurrentHint(newLevel === 1 ? (questionObj.hint1 || null) : (questionObj.hint2 || null))
      setStudyCardState(newStates)
      setStudyInput('')
      return
    }

    // Advance — correct, explanation type, or max hints exhausted
    setStudyHintLevel(0)
    setStudyCurrentHint(null)

    newStates[cardIdx] = {
      ...newStates[cardIdx],
      answers: [...cs.answers, answer],
      questionIdx: cs.questionIdx + 1,
      questionAttempts: newAttempts,
    }

    // Push to undo history
    setStudyAnswerHistory(prev => [...prev, { cardIdx, questionIdx }])

    if (newStates[cardIdx].questionIdx >= qpc) {
      newStates[cardIdx].done = true
      newStates[cardIdx].evaluating = true
      setStudyCardState(newStates)
      setStudyInput('')

      const remaining = newStates.filter(cs => !cs.done && cs.questionIdx < cs.questions.length)
      if (remaining.length > 0) {
        const nextActive = remaining[Math.floor(Math.random() * remaining.length)]
        setCurrentQuestion({ cardIdx: newStates.indexOf(nextActive), questionIdx: nextActive.questionIdx })
      } else {
        setCurrentQuestion(null)
      }
      evaluateCardAnswers(cardIdx, newStates[cardIdx])
      pullNewCard()
    } else {
      setStudyCardState(newStates)
      setStudyInput('')
      const nextQ = (() => {
        const active = newStates.filter(cs => !cs.done && cs.questionIdx < cs.questions.length)
        if (active.length === 0) return null
        const pick = active[Math.floor(Math.random() * active.length)]
        return { cardIdx: newStates.indexOf(pick), questionIdx: pick.questionIdx }
      })()
      setCurrentQuestion(nextQ)
    }
  }

  const undoLastAnswer = () => {
    if (studyAnswerHistory.length === 0) return
    const last = studyAnswerHistory[studyAnswerHistory.length - 1]
    const { cardIdx, questionIdx } = last
    const cs = studyCardState[cardIdx]
    if (!cs || cs.synced) return

    const newAttempts = [...(cs.questionAttempts || [])]
    newAttempts[questionIdx] = []
    const wasDone = cs.done

    setStudyCardState(prev => {
      const updated = [...prev]
      updated[cardIdx] = {
        ...cs,
        answers: cs.answers.slice(0, -1),
        questionIdx,
        questionAttempts: newAttempts,
        done: false,
        evaluating: false,
        ...(wasDone ? { results: [], rating: null, ease: null } : {}),
      }
      return updated
    })
    if (wasDone && cs.rating) setStudyStats(prev => ({ ...prev, [cs.rating]: Math.max(0, prev[cs.rating] - 1) }))
    setStudyAnswerHistory(prev => prev.slice(0, -1))
    setCurrentQuestion({ cardIdx, questionIdx })
    setStudyCurrentHint(null)
    setStudyHintLevel(0)
    setStudyInput('')
  }

  // Evaluate all answers for a completed card (runs in background, no blocking)
  const evaluateCardAnswers = async (cardIdx, cs) => {
    try {
      const rules = activeMode.studyRules || defaultStudyRules
      const studyLang = rules.studyLanguage || 'English'
      const grammarOn = rules.grammarFeedback || false
      const modeType = activeMode.type === 'language' ? `The student is learning a FOREIGN LANGUAGE (${activeMode.name}). Typos in ${studyLang} should be marked CORRECT if the concept is understood.` : `The student is studying ${activeMode.name}.`
      const grammarExtra = grammarOn ? ' For each answer also include "grammarNote" (correction or null) and "grammarRelevant" (true only if grammar error relates to what the card tests).' : ''

      const questionsAndAnswers = cs.questions.map((q, i) => {
        const isObj = typeof q === 'object' && q !== null
        const type = isObj ? (q.type || 'recall') : 'recall'
        const accepted = isObj && Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : []
        const acceptedLine = (type !== 'explanation' && accepted.length > 0)
          ? `\nAccepted answers (only these exact words count — synonyms are WRONG): ${accepted.join(', ')}`
          : ''
        return `Q${i+1} [${type}]: ${getQuestionText(q)}${acceptedLine}\nAnswer: ${cs.answers[i] || '(no answer)'}`
      }).join('\n\n')
      const prompt = `Evaluate ALL answers for this flashcard at once.\n\nCard front: "${cs.front}"\nCard back: "${cs.back}"\n\n${modeType}\n\n${questionsAndAnswers}\n\nGrading rules by question type:\n- recall / fill_blank: the answer MUST match one of the "Accepted answers" for that question. Normalize for case, accents, and minor typos. Synonyms, related words, or different words with the same meaning are INCORRECT — mark them wrong, and in the feedback acknowledge the synonym is related but note the specific word this card tests. If no "Accepted answers" line is given, fall back to the card back.\n- explanation: grade on conceptual understanding — accept any answer that correctly addresses the question.\nALWAYS note any grammar, spelling, or accent issues in the feedback (e.g. missing accent mark on brújula). These notes are educational, not penalizing.${grammarExtra}\n\nReturn a JSON array of ${cs.questions.length} objects: [{"correct": true/false, "feedback": "brief explanation including any grammar/accent notes"${grammarOn ? ', "grammarNote": "...", "grammarRelevant": true/false' : ''}}]\n\nOutput ONLY raw JSON. No markdown, no backticks.`

      const text = await providerConfig.call(apiKey, 'You evaluate flashcard answers. Always respond with valid JSON only.', prompt)
      const results = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))

      if (!Array.isArray(results)) return

      // Rate the card
      const qpc = cs.questions.length
      const wrongCount = results.filter(r => !r.correct || r.grammarRelevant).length
      let ease, label
      if (wrongCount === 0) { ease = 4; label = 'easy' }
      else if (wrongCount === 1) { ease = 3; label = 'good' }
      else if (wrongCount >= qpc) { ease = 1; label = 'again' }
      else { ease = 2; label = 'hard' }

      setStudyCardState(prev => {
        const updated = [...prev]
        updated[cardIdx] = { ...updated[cardIdx], results, rating: label, ease, evaluating: false }
        return updated
      })
      setStudyStats(prev => ({ ...prev, [label]: prev[label] + 1 }))

      // Check if all cards are done and evaluated
      setStudyCardState(prev => {
        const allDone = prev.every(cs => cs.done)
        const allEvaluated = prev.every(cs => !cs.evaluating)
        if (allDone && allEvaluated && !studyWrappingUpRef.current) {
          // All cards done — if no more in pool, go to summary
          if (studyBatchIdx >= studyAllCards.length) {
            setTimeout(() => setStudyPhase('summary'), 100)
          }
        }
        return prev
      })

      console.log('[Study] card evaluated:', cs.front, '→', label)
    } catch (err) {
      console.error('[Study] evaluation failed:', err.message)
      setStudyCardState(prev => {
        const updated = [...prev]
        updated[cardIdx] = { ...updated[cardIdx], evaluating: false, results: cs.questions.map(() => ({ correct: false, feedback: 'Evaluation failed' })), rating: 'again', ease: 1 }
        return updated
      })
    }
  }

  // Pull a new card from the pool to replace a completed one
  const pullNewCard = async () => {
    if (studyWrappingUpRef.current || studyBatchIdx >= studyAllCards.length) return
    const card = studyAllCards[studyBatchIdx]
    if (!card) return
    setStudyBatchIdx(prev => prev + 1)

    const rules = activeMode.studyRules || defaultStudyRules
    const studyLang = rules.studyLanguage || 'English'
    const knowledgeContext = studyKnowledge ? `\n\nReference material:\n${studyKnowledge.substring(0, 2000)}` : ''

    const questions = await generateQuestionsForCard(card, rules, studyLang, knowledgeContext)
    if (studyWrappingUpRef.current) return

    setStudyCardState(prev => [...prev, {
      cardId: card.cardId, front: getCardFront(card), back: getCardBack(card),
      questions, answers: [], results: [], done: false, questionIdx: 0,
    }])
    console.log('[Study] pulled new card:', getCardFront(card))
  }

  // startBatch is no longer used in the new system but keep for compatibility
  const startBatch = async () => {}

  // Sync all completed card ratings to Anki (called when going to summary or explicitly)
  const syncRatingsToAnki = async () => {
    const ratingsToSync = studyCardState.filter(cs => cs.done && cs.ease && cs.rating !== 'deleted' && !cs.synced)
    if (ratingsToSync.length > 0) {
      try {
        await ankiAnswerCards(ratingsToSync.map(cs => ({ cardId: cs.cardId, ease: cs.ease })))
        ankiSync().catch(() => {})
        ankiGetDeckStats([studyDeck]).then(s => {
          const ds = Object.values(s)[0]
          if (ds) setStudyDeckStats(ds)
        }).catch(() => {})
        // Mark as synced
        setStudyCardState(prev => prev.map(cs => cs.done && cs.ease ? { ...cs, synced: true } : cs))
        console.log('[Study] synced', ratingsToSync.length, 'card ratings to Anki')
      } catch (err) {
        console.warn('[Study] failed to sync ratings:', err.message)
      }
    }
  }

  const nextBatch = async () => {
    await syncRatingsToAnki()
    setStudyPhase('summary')
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
    setStudyWrappingUp(false)
    studyWrappingUpRef.current = false
    setStudyDeleteConfirm(null)
    setStudyFeedbackChat({})
    setStudyInsights(null)
    setCurrentQuestion(null)
    setStudyCurrentHint(null)
    setStudyHintLevel(0)
    setStudyAnswerHistory([])
  }

  // Generate spaced repetition insights + update progress observations
  const generateStudyInsights = async () => {
    if (!apiKey || studyInsightsLoading || studyCardState.length === 0) return
    setStudyInsightsLoading(true)
    try {
      // Load existing progress observations
      let existingProgress = ''
      try {
        const r = await fetch(`/api/deck-progress?deck=${encodeURIComponent(studyDeck)}`)
        const d = await r.json()
        existingProgress = d.content || ''
      } catch {}

      const sessionSummary = studyCardState.filter(cs => cs.done).map(cs => {
        const wrongQs = cs.results.filter(r => !r.correct).map((r, i) => cs.questions[i]).join('; ')
        return `Card: "${cs.front}" → Rating: ${cs.rating}${wrongQs ? ` (struggled with: ${wrongQs})` : ''}`
      }).join('\n')

      const prompt = `Analyze this study session and update the progress observations.

Session results for deck "${studyDeck}":
${sessionSummary}

${existingProgress ? `Previous progress observations:\n${existingProgress}` : 'No previous observations — this is the first session.'}

Respond with TWO sections separated by "---":

SECTION 1: Brief insight message for the student (2-4 sentences). Mention what they did well, what they struggled with, and any improvements from previous observations.

---

SECTION 2: Updated progress-observations.md content. Keep the format:
# Progress Observations — ${studyDeck}
Last updated: ${new Date().toISOString().split('T')[0]}

## Current Struggles
(list items)

## Improving
(items that were struggles but are getting better)

## Mastered (recently)
(items no longer a problem)`

      const text = await providerConfig.call(apiKey, 'You analyze study session results and track learning progress.', prompt)
      const parts = text.split('---')
      const insight = parts[0]?.trim() || text
      const newProgress = parts[1]?.trim()

      setStudyInsights(insight)

      // Save updated progress observations
      if (newProgress) {
        try {
          await fetch('/api/deck-progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deck: studyDeck, content: newProgress }),
          })
          console.log('[Study] progress observations updated for:', studyDeck)
        } catch {}
      }
    } catch (err) {
      setStudyInsights('Could not generate insights: ' + err.message)
    } finally {
      setStudyInsightsLoading(false)
    }
  }

  // Wrap Up — stop new cards, discard unstarted ones, finish in-progress only
  const studyWrapUp = () => {
    studyWrappingUpRef.current = true
    setStudyWrappingUp(true)
    setStudyCardState(prev => {
      const currentCardIdx = currentQuestion?.cardIdx ?? -1
      return prev.map((cs, idx) => {
        if (!cs.done && cs.answers.length === 0 && idx !== currentCardIdx) {
          return { ...cs, done: true, skipped: true }
        }
        return cs
      })
    })
  }

  // End Now — immediately go to summary with partial results
  const studyEndNow = () => {
    // Rate any unfinished cards as "again"
    const newStates = [...studyCardState]
    newStates.forEach((cs) => {
      if (!cs.done) {
        cs.done = true
        cs.rating = 'again'
        setStudyStats((prev) => ({ ...prev, again: prev.again + 1 }))
      }
    })
    setStudyCardState(newStates)
    setStudyPhase('summary')
    setStudyWrappingUp(false)
    studyWrappingUpRef.current = false
  }

  // "I know this" — delete card from Anki
  const studyDeleteKnownCard = async (cardIdx) => {
    const cs = studyCardState[cardIdx]
    try {
      // Find the noteId from the card
      const card = studyAllCards.find(c => c.cardId === cs.cardId)
      if (card) {
        await ankiDeleteNotes([card.note])
        ankiSync().catch(() => {})
      }
      // Mark as done + deleted, skip remaining questions
      const newStates = [...studyCardState]
      newStates[cardIdx] = { ...newStates[cardIdx], done: true, rating: 'deleted' }
      setStudyCardState(newStates)
      // Remove remaining questions for this card from queue
      const newQueue = studyQueue.filter((q, i) => i <= studyQueueIdx || q.cardIdx !== cardIdx)
      setStudyQueue(newQueue)
      setStudyDeleteConfirm(null)
      // If no more questions, go to batch feedback
      if (studyQueueIdx + 1 >= newQueue.length) {
        setStudyPhase('batchFeedback')
      }
    } catch (err) {
      console.error('[Study] delete failed:', err.message)
      setStudyDeleteConfirm(null)
    }
  }

  // Chat about feedback for a specific card — can fix typos, re-rate, update card
  const sendStudyFeedbackChat = async (cardIdx) => {
    const chat = studyFeedbackChat[cardIdx] || { messages: [], input: '', loading: false }
    const q = chat.input?.trim()
    if (!q || !apiKey || chat.loading) return
    const cs = studyCardState[cardIdx]
    const newMessages = [...(chat.messages || []), { role: 'user', text: q }]
    setStudyFeedbackChat(prev => ({ ...prev, [cardIdx]: { ...chat, messages: newMessages, input: '', loading: true } }))
    try {
      const resultsContext = cs.questions.map((question, qi) =>
        `Q${qi+1}: ${getQuestionText(question)}\nAnswer: ${cs.answers[qi] || '(skipped)'}\nResult: ${cs.results[qi]?.correct ? 'Correct' : 'Incorrect'} — ${cs.results[qi]?.feedback}`
      ).join('\n\n')
      const systemPrompt = `You are a study tutor. The student just studied this flashcard:
Front: "${cs.front}"
Back: "${cs.back}"

Their results:
${resultsContext}

IMPORTANT: Always trust the student. Be supportive, never argumentative.

The student may:
1. Report a typo or correction (e.g. "I meant guadaña", "that was a typo") — ALWAYS trust them. If their intended answer demonstrates they knew the concept on the card, mark ALL questions correct using mark_all_correct. Do not demand full explanations or argue.
2. Explicitly ask to mark things correct (e.g. "mark all as correct", "just do it", "i knew it", "count it") — ALWAYS honor this with mark_all_correct, no resistance.
3. Flag an out-of-scope question — if genuinely unfair, include <action>{"type":"bad_question","questionIndex":N,"reason":"..."}</action>
4. Ask to update the Anki card — include <action>{"type":"update_card","newFront":"...","newBack":"..."}</action>

To mark ALL questions correct: <action>{"type":"mark_all_correct","reason":"brief reason"}</action>
To mark ONE question correct: <action>{"type":"fix_typo","questionIndex":N,"correctedAnswer":"...","shouldBeCorrect":true}</action>

Respond in 1-2 sentences max. Always include the action tag when applicable. Never refuse a student's correction request.`
      const fullPrompt = newMessages.map(m => `${m.role === 'user' ? 'User' : 'Tutor'}: ${m.text}`).join('\n')
      const text = await providerConfig.call(apiKey, systemPrompt, fullPrompt)

      // Parse and execute actions from the response
      const actionMatches = [...text.matchAll(/<action>(.*?)<\/action>/gs)]
      const cleanText = text.replace(/<action>.*?<\/action>/gs, '').trim()
      let updatedStates = null

      for (const match of actionMatches) {
        try {
          const action = JSON.parse(match[1])
          if (action.type === 'mark_all_correct') {
            if (!updatedStates) updatedStates = [...studyCardState]
            updatedStates[cardIdx] = { ...updatedStates[cardIdx] }
            updatedStates[cardIdx].results = updatedStates[cardIdx].results.map(r => ({ ...r, correct: true, feedback: 'Marked correct.' }))
          } else if (action.type === 'fix_typo' && action.shouldBeCorrect) {
            // Re-evaluate: mark the question as correct
            if (!updatedStates) updatedStates = [...studyCardState]
            const qi = action.questionIndex
            if (qi >= 0 && qi < updatedStates[cardIdx].results.length) {
              updatedStates[cardIdx] = { ...updatedStates[cardIdx] }
              updatedStates[cardIdx].results = [...updatedStates[cardIdx].results]
              updatedStates[cardIdx].results[qi] = { ...updatedStates[cardIdx].results[qi], correct: true, feedback: `Typo corrected: "${action.correctedAnswer}" — Correct!` }
              updatedStates[cardIdx].answers = [...updatedStates[cardIdx].answers]
              updatedStates[cardIdx].answers[qi] = action.correctedAnswer + ' (corrected)'
            }
          } else if (action.type === 'update_card') {
            // Update the Anki card
            const card = studyAllCards.find(c => c.cardId === cs.cardId)
            if (card) {
              const fields = card.fields ? Object.entries(card.fields).sort(([,a],[,b]) => a.order - b.order) : []
              const updates = {}
              if (fields[0]) updates[fields[0][0]] = (action.newFront || '').replace(/\n/g, '<br>')
              if (fields[1]) updates[fields[1][0]] = (action.newBack || '').replace(/\n/g, '<br>')
              await ankiUpdateNote(card.note, updates)
              ankiSync().catch(() => {})
            }
          }
        } catch {}
      }

      // Re-rate the card if results were changed
      if (updatedStates) {
        const qpc = updatedStates[cardIdx].results.length
        const wrongCount = updatedStates[cardIdx].results.filter(r => !r.correct || r.grammarRelevant).length
        let label
        if (wrongCount === 0) label = 'easy'
        else if (wrongCount === 1) label = 'good'
        else if (wrongCount >= qpc) label = 'again'
        else label = 'hard'
        // Update stats: remove old rating, add new
        const oldRating = updatedStates[cardIdx].rating
        if (oldRating && oldRating !== label) {
          setStudyStats(prev => ({ ...prev, [oldRating]: Math.max(0, prev[oldRating] - 1), [label]: prev[label] + 1 }))
        }
        updatedStates[cardIdx].rating = label
        updatedStates[cardIdx].synced = false
        setStudyCardState(updatedStates)
      }

      setStudyFeedbackChat(prev => ({
        ...prev,
        [cardIdx]: { messages: [...newMessages, { role: 'assistant', text: cleanText }], input: '', loading: false }
      }))
    } catch (err) {
      setStudyFeedbackChat(prev => ({
        ...prev,
        [cardIdx]: { messages: [...newMessages, { role: 'assistant', text: 'Error: ' + err.message }], input: '', loading: false }
      }))
    }
  }

  // ─── Chat Tab Functions ──────────────────────────────────────────────────
  const chatTabAttachDeck = async (deckName) => {
    if (!deckName) { setChatTabAttachedDeck(null); return }
    setChatTabAttachLoading(true)
    try {
      const noteIds = await ankiFindNotes(`deck:"${deckName}"`)
      const notes = noteIds.length > 0 ? await ankiNotesInfo(noteIds.slice(0, 100)) : []
      const cards = notes.map(n => {
        const fields = Object.values(n.fields).sort((a, b) => a.order - b.order)
        return { front: stripHtml(fields[0]?.value || ''), back: stripHtml(fields[1]?.value || '') }
      })
      // Load progress observations
      let progress = ''
      try {
        const r = await fetch(`/api/deck-progress?deck=${encodeURIComponent(deckName)}`)
        const d = await r.json()
        progress = d.content || ''
      } catch {}
      setChatTabAttachedDeck({ name: deckName, cards, progress })
    } catch (err) {
      console.error('[Chat] attach deck failed:', err)
    } finally {
      setChatTabAttachLoading(false)
    }
  }

  const sendChatTabMessage = async () => {
    const q = chatTabInput.trim()
    if (!q || !apiKey || chatTabLoading) return
    const newMsgs = [...chatTabMsgs, { role: 'user', content: q }]
    setChatTabMsgs(newMsgs)
    setChatTabInput('')
    setChatTabLoading(true)
    setTimeout(() => chatTabScrollRef.current?.scrollTo({ top: chatTabScrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
    try {
      let systemPrompt = `You are a helpful study assistant. The user is studying with mode "${activeMode.name}".

IMPORTANT BEHAVIOR RULES:
1. When the user asks you to "make a deck" or "create cards" for a topic:
   - DO NOT immediately generate cards
   - Instead, ASK the user: "I can help with that! Would you like me to: (1) Search for top-rated existing Anki decks for this topic online, or (2) Generate custom cards based on specific objectives or materials you provide?"
   - If they want to search: suggest they use the "Find Decks" feature (coming soon), or recommend searching AnkiWeb at ankiweb.net/shared/decks for "[topic]" and advise what to look for (high ratings, recent updates, comprehensive coverage)
   - If they want custom cards: ask what specific topics, chapters, or objectives to cover. Ask if they have materials in their Knowledge Base. Then generate cards systematically by topic.

2. When creating flashcards (after the user confirms what they want):
   - Generate cards one topic at a time, not all at once
   - Use this JSON format wrapped in <anki-card> tags:
   {"front": "...", "back": "...", "tags": [...]}
   - Make cards high quality: clear fronts, comprehensive backs, relevant tags
   - Ask if they want more cards on the same topic or move to the next

3. For general questions: be concise and helpful. Explain concepts clearly.

4. NEVER dump a wall of cards without asking first. Quality over quantity.`

      // Web search if enabled
      let searchSources = null
      if (chatTabWebSearch) {
        setChatTabStatus('searching')
        systemPrompt += '\n\n5. You have WEB SEARCH capability. Search results from the internet are provided below. You MUST use them to answer the user\'s question. Do NOT say you cannot search the internet — the search has already been performed for you. You MUST cite your sources inline using [Source Title](URL) format for every claim based on search results.'
        try {
          const searchRes = await fetch(`/api/web-search?q=${encodeURIComponent(q)}`)
          const searchData = await searchRes.json()
          if (searchData.results?.length > 0) {
            searchSources = searchData.results
            setChatTabStatus('search-done')
            systemPrompt += `\n\nWEB SEARCH RESULTS for "${q}":\n` +
              searchData.results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`).join('\n\n') +
              '\n\nBase your answer on these search results. You MUST cite source URLs inline. At the end of your response, list all sources you used in this format:\n<sources>\nTitle | URL\nTitle | URL\n</sources>'
          } else {
            setChatTabStatus('search-empty')
            systemPrompt += '\n\nWeb search returned no results. Answer from your own knowledge but mention the search found nothing.'
          }
        } catch {
          setChatTabStatus('search-failed')
          systemPrompt += '\n\nWeb search failed. Answer from your own knowledge but mention the search encountered an error.'
        }
      }
      setChatTabStatus('thinking')

      if (chatTabAttachedDeck) {
        const cardSummary = chatTabAttachedDeck.cards.map(c => `• ${c.front} → ${c.back}`).join('\n')
        systemPrompt += `\n\nThe user has attached their Anki deck "${chatTabAttachedDeck.name}" (${chatTabAttachedDeck.cards.length} cards).
${chatTabAttachedDeck.progress ? `Progress observations:\n${chatTabAttachedDeck.progress}\n` : ''}
Card contents (all ${chatTabAttachedDeck.cards.length} cards):\n${cardSummary}

Focus on their weak areas. If you discover new struggles or notice improvement, wrap observation updates in <progress-update>new content for the file</progress-update> tags.`
      }

      const convo = newMsgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
      const text = await providerConfig.call(apiKey, systemPrompt, convo)

      // Parse anki cards from response
      const cardMatches = [...text.matchAll(/<anki-card>(.*?)<\/anki-card>/gs)]
      const parsedCards = cardMatches.map(m => { try { return JSON.parse(m[1]) } catch { return null } }).filter(Boolean)

      // Parse progress updates
      const progressMatches = [...text.matchAll(/<progress-update>([\s\S]*?)<\/progress-update>/g)]
      if (progressMatches.length > 0 && chatTabAttachedDeck) {
        for (const pm of progressMatches) {
          try {
            await fetch('/api/deck-progress', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deck: chatTabAttachedDeck.name, content: pm[1].trim() }),
            })
            setChatTabAttachedDeck(prev => prev ? { ...prev, progress: pm[1].trim() } : prev)
          } catch {}
        }
      }

      // Parse sources from response
      const sourcesMatch = text.match(/<sources>([\s\S]*?)<\/sources>/)
      let sources = searchSources // fallback to raw search results
      if (sourcesMatch) {
        const cited = sourcesMatch[1].trim().split('\n').map(line => {
          const parts = line.split('|').map(s => s.trim())
          if (parts.length >= 2) return { title: parts[0], url: parts[1] }
          return null
        }).filter(Boolean)
        if (cited.length > 0) sources = cited
      }

      const cleanText = text.replace(/<anki-card>.*?<\/anki-card>/gs, '').replace(/<progress-update>[\s\S]*?<\/progress-update>/g, '').replace(/<sources>[\s\S]*?<\/sources>/g, '').trim()
      const assistantMsg = { role: 'assistant', content: cleanText, cards: parsedCards.length > 0 ? parsedCards : undefined, sources: sources || undefined }
      const updatedMsgs = [...newMsgs, assistantMsg]
      setChatTabMsgs(updatedMsgs)
      setTimeout(() => chatTabScrollRef.current?.scrollTo({ top: chatTabScrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
      // Auto-save to disk after each response
      const savedId = await chatTabSaveCurrent(updatedMsgs, chatTabSessionId)
      if (!chatTabSessionId) setChatTabSessionId(savedId)
    } catch (err) {
      setChatTabMsgs(prev => [...prev, { role: 'assistant', content: 'Error: ' + err.message }])
    } finally {
      setChatTabLoading(false)
      setChatTabStatus(null)
    }
  }

  const chatTabSyncCard = async (card, msgIdx) => {
    if (!ankiConnected) return
    const deck = ankiDeck || ankiDecks[0] || 'Default'
    try {
      await ankiAddNote(deck, card.front, card.back, card.tags || ['screenlens'])
      ankiSync().catch(() => {})
      // Mark card as synced in the message
      setChatTabMsgs(prev => prev.map((m, i) => {
        if (i !== msgIdx || !m.cards) return m
        return { ...m, cards: m.cards.map(c => c === card ? { ...c, synced: true } : c) }
      }))
    } catch (err) {
      console.error('[Chat] sync card failed:', err)
    }
  }

  // Save current chat to disk
  const chatTabSaveCurrent = async (msgs, sessionId, title, { refreshList = true } = {}) => {
    if (!msgs || msgs.length === 0) return sessionId
    const chatTitle = title || msgs[0]?.content?.slice(0, 40) || 'Untitled'
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId || undefined, title: chatTitle, messages: msgs }),
      })
      const data = await res.json()
      if (refreshList) {
        const sessions = await fetch('/api/chats').then(r => r.json()).catch(() => [])
        setChatTabSessions(sessions)
      }
      return data.id
    } catch (err) {
      console.error('[Chat] save failed:', err)
      return sessionId
    }
  }

  const chatTabNewChat = async () => {
    // Save current session if it has messages
    if (chatTabMsgs.length > 0) {
      await chatTabSaveCurrent(chatTabMsgs, chatTabSessionId)
    }
    setChatTabMsgs([])
    setChatTabSessionId(null)
  }

  const chatTabLoadSession = async (session) => {
    // Save current first (don't refresh list — avoid reordering)
    if (chatTabMsgs.length > 0 && chatTabSessionId !== session.id) {
      await chatTabSaveCurrent(chatTabMsgs, chatTabSessionId, undefined, { refreshList: false })
    }
    // Load full messages from disk
    try {
      const data = await fetch(`/api/chat-load?id=${encodeURIComponent(session.id)}`).then(r => r.json())
      const msgs = (data.messages || []).map(m => ({ ...m, content: m.content || m.text }))
      setChatTabMsgs(msgs)
      setChatTabSessionId(session.id)
    } catch {
      setChatTabMsgs([])
      setChatTabSessionId(session.id)
    }
  }

  const chatTabDeleteSession = async (id) => {
    try {
      await fetch(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setChatTabSessions(prev => prev.filter(s => s.id !== id))
      if (chatTabSessionId === id) { setChatTabMsgs([]); setChatTabSessionId(null) }
    } catch {}
  }

  const chatTabRenameSession = async (id, newTitle) => {
    // Load the session, update title, save back
    try {
      const data = await fetch(`/api/chat-load?id=${encodeURIComponent(id)}`).then(r => r.json())
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: newTitle, messages: data.messages }),
      })
      setChatTabSessions(prev => prev.map(s => s.id === id ? { ...s, title: newTitle } : s))
      setChatTabEditingTitle(null)
    } catch {}
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
      // Convert to rich HTML for Anki
      const ankiBack = ankiCard.back
        .split('\n')
        .map(line => {
          // Bold the label before the colon
          const match = line.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+):(.*)$/)
          if (match) return `<b>${match[1]}:</b>${match[2]}`
          return line
        })
        .join('<br>')
      const noteId = await ankiAddNote(ankiDeck, ankiCard.front, ankiBack, ankiCard.tags)
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
  const renderWordOverlays = (cropMode) => {
    if (!imgDims.w || !imgDims.h) return null

    // In crop mode (transparent area-select), bboxes are relative to the crop — no offset needed
    // Otherwise, offset bboxes to full-image coordinates
    const off = cropMode ? { x: 0, y: 0 } : (selectionOffset || { x: 0, y: 0 })
    // In crop mode, use the crop's pixel dimensions for percentage calculation
    const refW = cropMode && selectionCrop ? selectionCrop.w : imgDims.w
    const refH = cropMode && selectionCrop ? selectionCrop.h : imgDims.h

    const boxes = ocrWords.map((word) => {
      const { x0, y0, x1, y1 } = word.bbox
      const h = y1 - y0
      const vPad = Math.round(h * 0.1)
      return { x0: x0 + off.x, y0: y0 + vPad + off.y, x1: x1 + off.x, y1: y1 - vPad + off.y }
    })

    // Clamp same-row overlaps
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const avgH = ((a.y1 - a.y0) + (b.y1 - b.y0)) / 2
        if (Math.abs(a.y0 - b.y0) > avgH * 0.5) continue
        if (a.x1 > b.x0 && a.x0 < b.x0) a.x1 = b.x0 - 1
        else if (b.x1 > a.x0 && b.x0 < a.x0) b.x1 = a.x0 - 1
      }
    }

    return ocrWords.map((word, i) => {
      const box = boxes[i]
      const x = (box.x0 / refW) * 100
      const y = (box.y0 / refH) * 100
      const w = Math.max(0, ((box.x1 - box.x0) / refW) * 100)
      const h = Math.max(0, ((box.y1 - box.y0) / refH) * 100)
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
      style={isOverlay ? {
        ...S.app, height: '100vh', overflow: 'hidden',
        background: ((selectionMode || selectionViewport || (areaSelectBounds && pinnedIdx !== null)) && activeMode.areaSelectTransparent !== false) ? 'transparent' : S.app.background,
      } : S.app}
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
          <div style={S.tabBar}>
            {['chat', 'study', 'picture', 'stats'].map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab)
                  setChatSidePanel(false)
                }}
                style={{ ...S.tab, ...(activeTab === tab ? S.tabActive : {}) }}
              >
                {{ chat: 'Chat', study: 'Study', picture: 'Picture', stats: 'Stats' }[tab]}
              </button>
            ))}
          </div>
        </div>
        <div style={S.headerRight}>
          {/* Picture tab: context buttons */}
          {activeTab === 'picture' && stage === 'done' && (
            <button onClick={() => setShowHighlights(!showHighlights)} style={{
              ...S.ghostBtn,
              color: showHighlights ? '#d2a8ff' : '#7d8590',
              borderColor: showHighlights ? 'rgba(210,168,255,0.25)' : '#2a3040',
            }}>
              {showHighlights ? '● Highlights' : '○ Highlights'}
            </button>
          )}

          {activeTab === 'picture' && stage !== 'idle' && <button onClick={reset} style={S.ghostBtn}>New</button>}

          {activeTab === 'picture' && screenshot && !loading && stage === 'done' && (
            <button onClick={() => analyzeImage(screenshot)} style={S.ghostBtn}>Re-analyze</button>
          )}

          {/* Mode selector + Settings gear — always visible */}
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

          {/* AI Provider button — replaces provider dropdown + Key Set */}
          <button onClick={() => setShowKeyInput(!showKeyInput)} style={{
            ...S.ghostBtn,
            color: providerConfig.color,
            borderColor: `${providerConfig.color}44`,
          }}>
            {providerConfig.label} {apiKey ? '' : '(no key)'}
          </button>

          {/* Picture tab: Capture, Upload, Overlay */}
          {activeTab === 'picture' && (
            <>
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
                  try { await fetch('/api/launch-overlay', { method: 'DELETE' }); setOverlayRunning(false) } catch {}
                } else {
                  try {
                    const r = await fetch('/api/launch-overlay', { method: 'POST' })
                    const d = await r.json()
                    if (d.error) { alert(d.error) } else { setOverlayRunning(true) }
                  } catch (err) { alert('Failed to launch overlay: ' + err.message) }
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
            </>
          )}
        </div>
      </header>}

      {/* ── AI Provider Settings ──────────────────────────────────────────── */}
      {showKeyInput && (
        <div style={{ ...S.keyBar, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>AI Provider Settings</span>
            <button onClick={() => setShowKeyInput(false)} style={{ ...S.ghostBtn, fontSize: 10, padding: '3px 8px' }}>Close</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(PROVIDERS).map(([key, p]) => (
              <button key={key} onClick={() => setProvider(key)} style={{
                ...S.ghostBtn, fontSize: 11, padding: '4px 12px',
                color: provider === key ? p.color : '#7d8590',
                borderColor: provider === key ? `${p.color}66` : '#2a3040',
                background: provider === key ? `${p.color}11` : 'transparent',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: apiKeys[key] ? '#7ee787' : '#484f58', display: 'inline-block', marginRight: 6 }} />
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setCurrentKey(e.target.value)}
              placeholder={providerConfig.placeholder}
              style={{ ...S.keyInput, flex: 1 }}
            />
            <a href={providerConfig.url} target="_blank" rel="noopener noreferrer" style={S.getKeyLink}>Get key</a>
          </div>
          <span style={{ fontSize: 10, color: '#484f58' }}>Keys stored in localStorage only</span>
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
          {/* Language Settings */}
          {activeMode.type === 'language' && (
            <div style={{
              padding: '8px 12px', borderRadius: 6,
              background: 'rgba(88,166,255,.06)', border: '1px solid rgba(88,166,255,.25)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff', marginBottom: 6 }}>Language Settings</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: '#7d8590' }}>Source:</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...S.select, fontSize: 11, flex: 1, minWidth: 120 }}>
                  {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <span style={{ color: '#58a6ff', fontWeight: 700 }}>→</span>
                <span style={{ fontSize: 11, color: '#7d8590' }}>Target:</span>
                <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)} style={{ ...S.select, fontSize: 11, flex: 1, minWidth: 120 }}>
                  {LANGS.filter((l) => l.code !== 'auto').map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
            </div>
          )}

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

          {/* Overlay Settings */}
          <div style={{
            padding: '8px 12px', borderRadius: 6,
            background: 'rgba(210,168,255,.06)', border: '1px solid rgba(210,168,255,.25)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#d2a8ff', marginBottom: 6 }}>Overlay Settings</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#c9d1d9', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={activeMode.areaSelectTransparent !== false}
                onChange={() => updateActiveMode({ areaSelectTransparent: !(activeMode.areaSelectTransparent !== false) })}
              />
              Transparent background on area select (Ctrl+Shift+A)
            </label>
            <div style={{ fontSize: 10, color: '#7d8590', marginTop: 3 }}>
              When enabled, only the selected area stays frozen — the rest of the screen shows through live.
            </div>
          </div>

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
      {activeTab === 'study' && deckBrowserActive && (
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
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input
                                type="text"
                                value={deckBrowserRefineInput}
                                onChange={(e) => setDeckBrowserRefineInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') refineDeckBrowserCard() }}
                                placeholder='e.g. "Say football instead of soccer"'
                                style={{ flex: 1, background: '#161b22', color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 4, padding: '5px 8px', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
                              />
                              <button
                                onClick={refineDeckBrowserCard}
                                disabled={deckBrowserRefining || !deckBrowserRefineInput.trim()}
                                style={{ background: 'rgba(136,98,255,.15)', color: '#a78bfa', border: '1px solid rgba(136,98,255,.3)', borderRadius: 4, padding: '5px 10px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', opacity: (deckBrowserRefining || !deckBrowserRefineInput.trim()) ? 0.4 : 1 }}
                              >
                                {deckBrowserRefining ? 'Refining...' : 'Refine with AI'}
                              </button>
                            </div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <button onClick={() => saveEditNote(note.noteId)} disabled={deckBrowserSaveStatus === 'saving'} style={{ ...S.captureBtn, borderRadius: 5, fontSize: 11, padding: '5px 12px', opacity: deckBrowserSaveStatus === 'saving' ? 0.6 : 1 }}>{deckBrowserSaveStatus === 'saving' ? 'Saving...' : 'Save'}</button>
                              <button onClick={() => { setDeckBrowserEditing(null); setDeckBrowserRefineInput(''); setDeckBrowserSaveStatus(null) }} style={{ ...S.ghostBtn, fontSize: 11 }}>Cancel</button>
                              {deckBrowserSaveStatus === 'error' && <span style={{ fontSize: 10, color: '#f85149' }}>Save failed — is Anki open?</span>}
                              {deckBrowserSaveStatus === 'saved' && <span style={{ fontSize: 10, color: '#7ee787' }}>Saved</span>}
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

      {/* ── Study Tab Home (no active session or browser) ─────────────────── */}
      {activeTab === 'study' && !studyActive && !deckBrowserActive && (
        <main style={{ ...S.main, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ maxWidth: 400, width: '100%', textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 16 }}>Study</div>
            <div style={{ fontSize: 12, color: '#7d8590', marginBottom: 24 }}>Review your Anki cards with AI-powered quizzes or browse your decks.</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={() => { closeDeckBrowser(); startStudySession() }}
                disabled={studyLoading || ankiConnected === false}
                style={{ ...S.captureBtn, borderRadius: 8, fontSize: 13, padding: '10px 24px', opacity: (studyLoading || ankiConnected === false) ? 0.5 : 1 }}
              >
                {studyLoading ? 'Loading...' : 'Study Now'}
              </button>
              <button
                onClick={() => { exitStudy(); openDeckBrowser() }}
                disabled={ankiConnected === false}
                style={{ ...S.ghostBtn, fontSize: 13, padding: '10px 24px', color: '#d2a8ff', borderColor: 'rgba(210,168,255,0.25)', opacity: ankiConnected === false ? 0.5 : 1 }}
              >
                Browse Deck
              </button>
            </div>
            {ankiConnected === false && (
              <div style={{ fontSize: 11, color: '#d29922', marginTop: 12 }}>Anki is not connected. Start Anki with AnkiConnect addon.</div>
            )}
            {ankiConnected === null && (
              <div style={{ fontSize: 11, color: '#7d8590', marginTop: 12 }}>Checking Anki connection...</div>
            )}
          </div>
        </main>
      )}

      {/* ── Chat Tab ─────────────────────────────────────────────────────────── */}
      {activeTab === 'chat' && (
        <main style={{ ...S.main, display: 'flex', padding: 0, overflow: 'hidden' }}>
          {/* Session sidebar */}
          <div style={{ width: 200, borderRight: '1px solid #2a3040', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <button onClick={chatTabNewChat} style={{ ...S.captureBtn, margin: 8, borderRadius: 6, fontSize: 11, padding: '8px 12px' }}>
              + New Chat
            </button>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px' }}>
              {chatTabSessions.map(s => (
                <div key={s.id} onClick={() => chatTabLoadSession(s)} style={{
                  padding: '6px 8px', borderRadius: 4, fontSize: 10, color: chatTabSessionId === s.id ? '#e6edf3' : '#7d8590',
                  background: chatTabSessionId === s.id ? '#1c2129' : 'transparent',
                  cursor: 'pointer', marginBottom: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  {chatTabEditingTitle === s.id ? (
                    <input
                      autoFocus
                      defaultValue={s.title}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { if (e.key === 'Enter') chatTabRenameSession(s.id, e.target.value); if (e.key === 'Escape') setChatTabEditingTitle(null) }}
                      onBlur={(e) => chatTabRenameSession(s.id, e.target.value)}
                      style={{ background: '#161b22', color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 3, fontSize: 10, padding: '2px 4px', width: '100%', fontFamily: 'inherit' }}
                    />
                  ) : (
                    <span onDoubleClick={(e) => { e.stopPropagation(); setChatTabEditingTitle(s.id) }} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {s.type === 'help' && <span style={{ color: '#58a6ff', marginRight: 4, fontSize: 9 }}>?</span>}
                      {s.title}
                    </span>
                  )}
                  <span onClick={(e) => { e.stopPropagation(); chatTabDeleteSession(s.id) }} style={{ color: '#484f58', cursor: 'pointer', marginLeft: 4 }}>&times;</span>
                </div>
              ))}
              {chatTabSessions.length === 0 && <div style={{ fontSize: 10, color: '#484f58', padding: 8, textAlign: 'center' }}>No saved chats</div>}
            </div>
          </div>

          {/* Chat area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* Attached deck indicator */}
            {chatTabAttachedDeck && (
              <div style={{ padding: '6px 16px', borderBottom: '1px solid #2a3040', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#58a6ff' }}>
                <span>Attached: {chatTabAttachedDeck.name} ({chatTabAttachedDeck.cards.length} cards)</span>
                <span onClick={() => setChatTabAttachedDeck(null)} style={{ cursor: 'pointer', color: '#7d8590' }}>&times;</span>
              </div>
            )}

            {/* Messages */}
            <div ref={chatTabScrollRef} style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              {chatTabMsgs.length === 0 && (
                <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#e6edf3', marginBottom: 8 }}>AI Study Assistant</div>
                  <div style={{ fontSize: 12, color: '#7d8590', marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
                    Ask questions, create Anki cards, or attach a deck for personalized tutoring.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {['Explain subnetting', 'Make me a flashcard about DNS', 'Help me with verb conjugations'].map(hint => (
                      <button key={hint} onClick={() => { setChatTabInput(hint) }} style={{ ...S.ghostBtn, fontSize: 10, padding: '6px 12px' }}>
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {chatTabMsgs.map((m, i) => (
                <div key={i} style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '80%', padding: '10px 14px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
                    background: m.role === 'user' ? 'rgba(88,166,255,.12)' : '#1c2129',
                    border: `1px solid ${m.role === 'user' ? 'rgba(88,166,255,.2)' : '#2a3040'}`,
                    color: '#e6edf3', whiteSpace: 'pre-wrap',
                  }}>
                    {m.content}
                  </div>
                  {/* Inline Anki card previews */}
                  {m.cards?.map((card, ci) => (
                    <div key={ci} style={{
                      maxWidth: '80%', marginTop: 6, padding: '10px 14px', borderRadius: 8,
                      background: '#161b22', border: '1px solid #2a3040',
                    }}>
                      <div style={{ fontSize: 10, color: '#7d8590', fontWeight: 600, marginBottom: 4 }}>ANKI CARD</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>{card.front}</div>
                      <div style={{ fontSize: 11, color: '#c9d1d9', whiteSpace: 'pre-line', marginBottom: 6 }}>{card.back}</div>
                      {card.tags?.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                          {card.tags.map((t, ti) => <span key={ti} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(125,133,144,.15)', color: '#7d8590' }}>{t}</span>)}
                        </div>
                      )}
                      {card.synced ? (
                        <span style={{ fontSize: 10, color: '#7ee787' }}>Synced to Anki</span>
                      ) : (
                        <button onClick={() => chatTabSyncCard(card, i)} disabled={!ankiConnected}
                          style={{ ...S.ghostBtn, fontSize: 10, padding: '3px 10px', color: '#7ee787', borderColor: 'rgba(126,231,135,.3)', opacity: ankiConnected ? 1 : 0.4 }}>
                          Sync to Anki
                        </button>
                      )}
                    </div>
                  ))}
                  {/* Web search sources */}
                  {m.sources?.length > 0 && (
                    <div style={{ maxWidth: '80%', marginTop: 6, padding: '8px 12px', borderRadius: 6, background: 'rgba(88,166,255,.06)', border: '1px solid rgba(88,166,255,.12)' }}>
                      <div style={{ fontSize: 9, color: '#58a6ff', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sources</div>
                      {m.sources.map((src, si) => (
                        <div key={si} style={{ fontSize: 10, marginBottom: 2 }}>
                          <a href={src.url?.startsWith('http') ? src.url : `https://${src.url}`} target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff', textDecoration: 'none' }}>
                            {src.title || src.url}
                          </a>
                          {src.url && <span style={{ color: '#484f58', marginLeft: 6, fontSize: 9 }}>{src.url.replace(/^https?:\/\//, '').split('/')[0]}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {chatTabLoading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: chatTabStatus === 'searching' ? '#58a6ff' : chatTabStatus === 'search-done' ? '#7ee787' : chatTabStatus === 'search-empty' || chatTabStatus === 'search-failed' ? '#f0883e' : '#7d8590', fontSize: 12 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: chatTabStatus === 'searching' ? '#58a6ff' : chatTabStatus === 'thinking' ? '#d2a8ff' : '#58a6ff', animation: 'pulse 1.5s ease infinite' }} />
                    {chatTabStatus === 'searching' && 'Searching the web...'}
                    {chatTabStatus === 'search-done' && 'Found results. Analyzing...'}
                    {chatTabStatus === 'search-empty' && 'No results found. Answering from knowledge...'}
                    {chatTabStatus === 'search-failed' && 'Search failed. Answering from knowledge...'}
                    {chatTabStatus === 'thinking' && (chatTabWebSearch ? 'Generating response with search results...' : 'Thinking...')}
                    {!chatTabStatus && 'Thinking...'}
                  </div>
                </div>
              )}
            </div>

            {/* Input bar */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid #2a3040', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Attach deck row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!chatTabAttachedDeck && ankiConnected && (
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) chatTabAttachDeck(e.target.value) }}
                    style={{ ...S.select, fontSize: 10, padding: '3px 6px', color: '#7d8590', maxWidth: 160 }}
                  >
                    <option value="">Attach deck...</option>
                    {ankiDecks.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                )}
                {chatTabAttachLoading && <span style={{ fontSize: 10, color: '#7d8590' }}>Loading deck...</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => setChatTabWebSearch(prev => !prev)}
                  title={chatTabWebSearch ? 'Web search enabled' : 'Enable web search'}
                  style={{
                    background: chatTabWebSearch ? 'rgba(88,166,255,.15)' : 'transparent',
                    border: `1px solid ${chatTabWebSearch ? '#58a6ff' : '#2a3040'}`,
                    color: chatTabWebSearch ? '#58a6ff' : '#484f58',
                    borderRadius: 6, padding: '8px 10px', cursor: 'pointer',
                    fontSize: 14, lineHeight: 1, fontFamily: 'inherit',
                    transition: 'all 0.15s',
                  }}
                >&#127760;</button>
                <input
                  value={chatTabInput}
                  onChange={(e) => setChatTabInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatTabMessage() } }}
                  placeholder={chatTabWebSearch ? 'Search the web and ask...' : 'Ask anything, or tell me to make a flashcard...'}
                  style={{ ...S.keyInput, flex: 1, fontSize: 13, padding: '10px 14px' }}
                  disabled={chatTabLoading}
                />
                <button
                  onClick={sendChatTabMessage}
                  disabled={chatTabLoading || !chatTabInput.trim()}
                  style={{ ...S.captureBtn, borderRadius: 6, opacity: chatTabLoading || !chatTabInput.trim() ? 0.5 : 1 }}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* ── Stats Tab ────────────────────────────────────────────────────────── */}
      {activeTab === 'stats' && (() => {
        const history = (() => { try { return JSON.parse(localStorage.getItem('screenlens-study-history') || '[]') } catch { return [] } })()
        const today = new Date().toISOString().split('T')[0]
        const todayStats = history.filter(h => h.date === today)
        const todayCards = todayStats.reduce((s, h) => s + (h.cardsStudied || 0), 0)
        const todayCorrect = todayStats.reduce((s, h) => s + (h.correct || 0), 0)
        const todayTotal = todayStats.reduce((s, h) => s + (h.totalQuestions || 0), 0)

        // Streak: count consecutive days
        const dates = [...new Set(history.map(h => h.date))].sort().reverse()
        let streak = 0
        const d = new Date()
        for (let i = 0; i < 365; i++) {
          const dateStr = d.toISOString().split('T')[0]
          if (dates.includes(dateStr)) { streak++; d.setDate(d.getDate() - 1) }
          else if (i === 0) { d.setDate(d.getDate() - 1) } // allow today to not be studied yet
          else break
        }

        // Last 14 days chart
        const chartDays = []
        for (let i = 13; i >= 0; i--) {
          const dd = new Date(); dd.setDate(dd.getDate() - i)
          const ds = dd.toISOString().split('T')[0]
          const dayH = history.filter(h => h.date === ds)
          chartDays.push({ date: ds, label: dd.toLocaleDateString('en', { weekday: 'short' }), cards: dayH.reduce((s, h) => s + (h.cardsStudied || 0), 0) })
        }
        const maxCards = Math.max(1, ...chartDays.map(d => d.cards))

        // Per-deck breakdown
        const deckMap = {}
        history.forEach(h => {
          if (!deckMap[h.deck]) deckMap[h.deck] = { sessions: 0, cards: 0, lastDate: h.date }
          deckMap[h.deck].sessions++
          deckMap[h.deck].cards += h.cardsStudied || 0
          if (h.date > deckMap[h.deck].lastDate) deckMap[h.deck].lastDate = h.date
        })

        return (
        <main style={{ ...S.main, padding: 20 }}>
          <div style={{ maxWidth: 700, margin: '0 auto', width: '100%' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 20 }}>Stats</div>

            {/* Top row: streak + today */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: '#ffa657' }}>{streak}</div>
                <div style={{ fontSize: 11, color: '#7d8590' }}>Day Streak</div>
              </div>
              <div style={{ flex: 1, padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: '#58a6ff' }}>{todayCards}</div>
                <div style={{ fontSize: 11, color: '#7d8590' }}>Cards Today</div>
              </div>
              <div style={{ flex: 1, padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: '#7ee787' }}>{todayTotal > 0 ? Math.round(todayCorrect / todayTotal * 100) : 0}%</div>
                <div style={{ fontSize: 11, color: '#7d8590' }}>Accuracy Today</div>
              </div>
            </div>

            {/* 14-day chart */}
            <div style={{ padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', marginBottom: 12 }}>Last 14 Days</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 }}>
                {chartDays.map((day, i) => (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ fontSize: 9, color: '#7d8590' }}>{day.cards || ''}</div>
                    <div style={{
                      width: '100%', borderRadius: 2,
                      height: Math.max(2, (day.cards / maxCards) * 80),
                      background: day.date === today ? '#58a6ff' : day.cards > 0 ? 'rgba(88,166,255,.4)' : '#1a1f27',
                    }} />
                    <div style={{ fontSize: 8, color: '#484f58' }}>{day.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-deck breakdown */}
            <div style={{ padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', marginBottom: 12 }}>Decks</div>
              {Object.keys(deckMap).length === 0 && <div style={{ fontSize: 11, color: '#484f58' }}>No study history yet</div>}
              {Object.entries(deckMap).map(([deck, data]) => (
                <div key={deck} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #2a3040', fontSize: 11 }}>
                  <span style={{ color: '#e6edf3', fontWeight: 600 }}>{deck}</span>
                  <span style={{ color: '#7d8590' }}>{data.cards} cards / {data.sessions} sessions / last: {data.lastDate}</span>
                </div>
              ))}
            </div>

            {/* Recent sessions */}
            <div style={{ padding: '16px 20px', background: '#1c2129', border: '1px solid #2a3040', borderRadius: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', marginBottom: 12 }}>Recent Sessions</div>
              {history.length === 0 && <div style={{ fontSize: 11, color: '#484f58' }}>No sessions yet. Complete a study session to see stats here.</div>}
              {history.slice(0, 20).map((h, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #2a3040', fontSize: 11 }}>
                  <span style={{ color: '#7d8590' }}>{h.date}</span>
                  <span style={{ color: '#58a6ff' }}>{h.deck}</span>
                  <span style={{ color: '#e6edf3' }}>{h.cardsStudied} cards</span>
                  <span style={{ color: h.accuracy >= 80 ? '#7ee787' : h.accuracy >= 50 ? '#d29922' : '#f85149' }}>{h.accuracy}%</span>
                </div>
              ))}
            </div>
          </div>
        </main>
        )
      })()}

      {/* ── Study Session ────────────────────────────────────────────────────── */}
      {activeTab === 'study' && studyActive && (
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

                {/* Spaced repetition insights */}
                {!studyInsights && !studyInsightsLoading && (
                  <button onClick={generateStudyInsights} style={{ ...S.ghostBtn, fontSize: 11, marginBottom: 16, color: '#d2a8ff', borderColor: 'rgba(210,168,255,.25)' }}>
                    Generate Insights
                  </button>
                )}
                {studyInsightsLoading && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 16, color: '#7d8590', fontSize: 12 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#d2a8ff', animation: 'pulse 1.5s ease infinite' }} />
                    Analyzing your session...
                  </div>
                )}
                {studyInsights && (
                  <div style={{
                    textAlign: 'left', marginBottom: 16, padding: '12px 16px', borderRadius: 8,
                    background: 'rgba(210,168,255,.06)', border: '1px solid rgba(210,168,255,.15)',
                    fontSize: 12, color: '#c9d1d9', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#d2a8ff', marginBottom: 6 }}>Insights</div>
                    {studyInsights}
                  </div>
                )}

                <button onClick={exitStudy} style={{ ...S.captureBtn, borderRadius: 6 }}>Done</button>
              </div>
            )}

            {/* Question phase — 10-card continuous system */}
            {studyPhase === 'question' && (() => {
              const activeCount = studyCardState.filter(cs => !cs.done).length
              const completedCount = studyCardState.filter(cs => cs.done).length
              const cq = currentQuestion
              const cs = cq ? studyCardState[cq.cardIdx] : null
              const questionObj = cs ? cs.questions[cq.questionIdx] : null
              const question = getQuestionText(questionObj)
              const canUndo = studyAnswerHistory.length > 0 && !studyCardState[studyAnswerHistory[studyAnswerHistory.length - 1]?.cardIdx]?.synced

              return (
                <div>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                      <span style={{ color: '#58a6ff' }}>{activeCount} <span style={{ fontSize: 10, color: '#7d8590' }}>Active</span></span>
                      <span style={{ color: '#7ee787' }}>{completedCount} <span style={{ fontSize: 10, color: '#7d8590' }}>Done</span></span>
                      <span style={{ color: '#7d8590' }}>{studyDeckStats.new_count || 0} New / {studyDeckStats.learn_count || 0} Learn / {studyDeckStats.review_count || 0} Due</span>
                    </div>
                    <button onClick={exitStudy} style={{ ...S.ghostBtn, fontSize: 10 }}>Exit Study</button>
                  </div>

                  {/* Current question — card front is HIDDEN */}
                  {question ? (
                    <>
                      <div style={{ fontSize: 13, color: '#e6edf3', fontWeight: 600, marginBottom: 8 }}>
                        {question}
                      </div>

                      {studyCurrentHint && (
                        <div style={{ fontSize: 11, color: '#ffa657', background: 'rgba(255,166,87,.08)', border: '1px solid rgba(255,166,87,.2)', borderRadius: 5, padding: '5px 10px', marginBottom: 8 }}>
                          Hint: {studyCurrentHint}
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          value={studyInput}
                          onChange={(e) => setStudyInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') submitStudyAnswer() }}
                          placeholder={studyCurrentHint ? 'Try again...' : 'Type your answer...'}
                          style={{ ...S.keyInput, flex: 1, fontSize: 13, padding: '10px 14px' }}
                          autoFocus
                        />
                        <button onClick={submitStudyAnswer} disabled={!studyInput.trim()}
                          style={{ ...S.captureBtn, borderRadius: 6, opacity: !studyInput.trim() ? 0.5 : 1 }}>
                          {studyCurrentHint ? 'Try Again' : 'Submit'}
                        </button>
                      </div>

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => setStudyDeleteConfirm(cq.cardIdx)}
                            style={{ ...S.ghostBtn, fontSize: 10, color: '#7d8590', borderColor: '#2a3040' }}>
                            I know this already
                          </button>
                          {canUndo && (
                            <button onClick={undoLastAnswer} style={{ ...S.ghostBtn, fontSize: 10, color: '#7d8590', borderColor: '#2a3040' }}>← Back</button>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {!studyWrappingUp && (
                            <button onClick={studyWrapUp} style={{ ...S.ghostBtn, fontSize: 10, color: '#d29922', borderColor: 'rgba(210,153,34,.25)' }}>Wrap Up</button>
                          )}
                          <button onClick={studyEndNow} style={{ ...S.ghostBtn, fontSize: 10, color: '#f85149', borderColor: 'rgba(248,81,73,.25)' }}>End Now</button>
                        </div>
                      </div>

                      {studyDeleteConfirm === cq.cardIdx && (
                        <div style={{ padding: '10px 14px', borderRadius: 6, background: 'rgba(248,81,73,.06)', border: '1px solid rgba(248,81,73,.15)', marginTop: 8 }}>
                          <div style={{ fontSize: 12, color: '#e6edf3', marginBottom: 8 }}>Delete this card from Anki?</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => studyDeleteKnownCard(cq.cardIdx)} style={{ ...S.ghostBtn, fontSize: 11, color: '#f85149', borderColor: 'rgba(248,81,73,.3)' }}>Yes, delete</button>
                            <button onClick={() => setStudyDeleteConfirm(null)} style={{ ...S.ghostBtn, fontSize: 11 }}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {studyWrappingUp && (
                        <div style={{ fontSize: 10, color: '#d29922', marginTop: 4, textAlign: 'center' }}>Wrapping up — finishing current cards...</div>
                      )}
                    </>
                  ) : (
                    <div style={{ textAlign: 'center', color: '#7d8590', fontSize: 12, padding: 20 }}>
                      {studyCardState.some(cs => cs.evaluating) ? 'Evaluating remaining cards...' : 'All cards completed!'}
                      {!studyCardState.some(cs => cs.evaluating) && (
                        <button onClick={() => setStudyPhase('summary')} style={{ ...S.captureBtn, borderRadius: 6, marginTop: 12, display: 'block', margin: '12px auto 0' }}>View Summary</button>
                      )}
                    </div>
                  )}

                  {/* Completed cards — show feedback inline as they finish */}
                  {studyCardState.filter(cs => cs.done && cs.results.length > 0 && !cs.dismissed).length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                      <button onClick={async () => {
                        await syncRatingsToAnki()
                        setStudyCardState(prev => prev.map(cs => cs.done && cs.results.length > 0 ? { ...cs, dismissed: true } : cs))
                        setStudySyncNotification(true)
                        setTimeout(() => setStudySyncNotification(false), 3000)
                      }} style={{ ...S.ghostBtn, fontSize: 11, color: '#7ee787', borderColor: 'rgba(126,231,135,.3)' }}>
                        Done — Sync to Anki
                      </button>
                    </div>
                  )}
                  {studySyncNotification && (
                    <div style={{ textAlign: 'center', marginTop: 8, fontSize: 11, color: '#7ee787' }}>Synced to Anki</div>
                  )}
                  {studyCardState.filter(cs => cs.done && cs.results.length > 0 && !cs.dismissed).map((cs, i) => {
                    const ci = studyCardState.indexOf(cs)
                    const ratingColors = { easy: '#7ee787', good: '#58a6ff', hard: '#d29922', again: '#f85149', deleted: '#7d8590' }
                    return (
                      <div key={ci} style={{ marginTop: 16, border: '1px solid #2a3040', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 12px', background: '#1c2129', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>{cs.front}</span>
                          {cs.evaluating ? (
                            <span style={{ fontSize: 11, color: '#7d8590' }}>Evaluating...</span>
                          ) : (
                            <select value={cs.rating || ''} onChange={(e) => {
                              const newRating = e.target.value
                              const easeMap = { easy: 4, good: 3, hard: 2, again: 1 }
                              setStudyCardState(prev => {
                                const updated = [...prev]
                                const oldRating = updated[ci].rating
                                updated[ci] = { ...updated[ci], rating: newRating, ease: easeMap[newRating] || 1 }
                                setStudyStats(s => ({
                                  ...s,
                                  [oldRating]: Math.max(0, (s[oldRating] || 0) - 1),
                                  [newRating]: (s[newRating] || 0) + 1,
                                }))
                                return updated
                              })
                            }} style={{ background: '#161b22', color: ratingColors[cs.rating] || '#7d8590', border: `1px solid ${ratingColors[cs.rating] || '#2a3040'}44`, borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: 'inherit', padding: '2px 6px', cursor: 'pointer' }}>
                              <option value="easy" style={{ color: '#7ee787' }}>EASY</option>
                              <option value="good" style={{ color: '#58a6ff' }}>GOOD</option>
                              <option value="hard" style={{ color: '#d29922' }}>HARD</option>
                              <option value="again" style={{ color: '#f85149' }}>AGAIN</option>
                            </select>
                          )}
                        </div>
                        {cs.results.map((r, qi) => (
                          <div key={qi} style={{ padding: '8px 12px', borderTop: '1px solid #2a3040', fontSize: 12, background: r.correct ? 'rgba(126,231,135,.03)' : 'rgba(248,81,73,.03)' }}>
                            <div style={{ color: r.correct ? '#7ee787' : '#f85149', fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
                              {r.correct ? '\u2713 CORRECT' : '\u2717 INCORRECT'}
                            </div>
                            <div style={{ color: '#7d8590', marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Q:</span> {getQuestionText(cs.questions[qi])}</div>
                            <div style={{ color: '#c9d1d9', marginBottom: 4 }}><span style={{ fontWeight: 600 }}>Your answer:</span> {cs.answers[qi]}</div>
                            <div style={{ color: r.correct ? '#7ee787' : '#ffa657', lineHeight: 1.5, fontSize: 11 }}>{r.feedback}</div>
                          </div>
                        ))}
                        <div style={{ padding: '4px 12px', borderTop: '1px solid #2a3040', fontSize: 10, color: '#484f58' }}>{cs.back}</div>
                        {/* Feedback chat */}
                        {!cs.evaluating && (
                          <div style={{ padding: '6px 12px', borderTop: '1px solid #2a3040' }}>
                            {(studyFeedbackChat[ci]?.messages || []).map((m, mi) => (
                              <div key={mi} style={{ fontSize: 11, padding: '4px 8px', marginBottom: 4, borderRadius: 4, background: m.role === 'user' ? 'rgba(88,166,255,.08)' : 'rgba(126,231,135,.05)', color: m.role === 'user' ? '#c9d1d9' : '#7ee787' }}>{m.text}</div>
                            ))}
                            {studyFeedbackChat[ci]?.loading && <div style={{ fontSize: 10, color: '#7d8590', padding: '2px 8px' }}>Thinking...</div>}
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input value={studyFeedbackChat[ci]?.input || ''} onChange={(e) => setStudyFeedbackChat(prev => ({ ...prev, [ci]: { ...(prev[ci] || { messages: [], loading: false }), input: e.target.value } }))} onKeyDown={(e) => { if (e.key === 'Enter') sendStudyFeedbackChat(ci) }} placeholder="Fix typo, flag bad question, or ask..." style={{ ...S.keyInput, flex: 1, fontSize: 10, padding: '4px 8px' }} />
                              <button onClick={() => sendStudyFeedbackChat(ci)} disabled={studyFeedbackChat[ci]?.loading || !(studyFeedbackChat[ci]?.input?.trim())} style={{ ...S.ghostBtn, fontSize: 9, padding: '4px 8px', opacity: (studyFeedbackChat[ci]?.loading || !(studyFeedbackChat[ci]?.input?.trim())) ? 0.4 : 1 }}>Ask</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Batch feedback — show all card results */}
            {studyPhase === 'batchFeedback' && (
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3', marginBottom: 16 }}>Batch Results</div>
                {studyCardState.map((cs, ci) => {
                  const ratingColors = { easy: '#7ee787', good: '#58a6ff', hard: '#d29922', again: '#f85149', deleted: '#7d8590' }
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
                            <span style={{ fontWeight: 600 }}>Q:</span> {getQuestionText(q)}
                          </div>
                          {cs.questionAttempts?.[qi]?.length > 1 && (
                            <div style={{ color: '#484f58', fontSize: 10, marginBottom: 3 }}>
                              Previous attempts: {cs.questionAttempts[qi].slice(0, -1).join(', ')}
                            </div>
                          )}
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
                      {/* Feedback chat — ask follow-up questions about this card */}
                      <div style={{ padding: '6px 12px', borderTop: '1px solid #2a3040' }}>
                        {(studyFeedbackChat[ci]?.messages || []).map((m, mi) => (
                          <div key={mi} style={{
                            fontSize: 11, padding: '4px 8px', marginBottom: 4, borderRadius: 4,
                            background: m.role === 'user' ? 'rgba(88,166,255,.08)' : 'rgba(126,231,135,.05)',
                            color: m.role === 'user' ? '#c9d1d9' : '#7ee787',
                          }}>
                            {m.text}
                          </div>
                        ))}
                        {studyFeedbackChat[ci]?.loading && (
                          <div style={{ fontSize: 10, color: '#7d8590', padding: '2px 8px' }}>Thinking...</div>
                        )}
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input
                            value={studyFeedbackChat[ci]?.input || ''}
                            onChange={(e) => setStudyFeedbackChat(prev => ({ ...prev, [ci]: { ...(prev[ci] || { messages: [], loading: false }), input: e.target.value } }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') sendStudyFeedbackChat(ci) }}
                            placeholder="Fix typo, flag bad question, or ask..."
                            style={{ ...S.keyInput, flex: 1, fontSize: 10, padding: '4px 8px' }}
                          />
                          <button onClick={() => sendStudyFeedbackChat(ci)}
                            disabled={studyFeedbackChat[ci]?.loading || !(studyFeedbackChat[ci]?.input?.trim())}
                            style={{ ...S.ghostBtn, fontSize: 9, padding: '4px 8px', opacity: (studyFeedbackChat[ci]?.loading || !(studyFeedbackChat[ci]?.input?.trim())) ? 0.4 : 1 }}>
                            Ask
                          </button>
                        </div>
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
      {(activeTab === 'picture' || isOverlay) && <main style={isOverlay ? { ...S.main, padding: 0, background: 'transparent' } : S.main}>
        {/* Empty state (hidden in overlay) */}
        {stage === 'idle' && !isOverlay && (
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
          <div style={isOverlay ? {} : { animation: 'fadeUp 0.25s ease', textAlign: 'center' }}>
            {/* Progress indicator */}
            {loading && !isOverlay && (
              <div style={{ ...S.progressBar, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={S.progressDot} />
                <span style={S.progressText}>{progress}</span>
                <button onClick={() => { cancelRef.current = true; setLoading(false); setStage('captured') }}
                  style={{ background: 'none', border: '1px solid #484f58', color: '#7d8590', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Cancel
                </button>
              </div>
            )}
            {/* Overlay progress — floating bottom bar */}
            {loading && isOverlay && (
              <div style={{
                position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(22,27,34,0.95)', border: '1px solid #2a3040',
                borderRadius: 8, padding: '8px 16px', zIndex: 9999,
                display: 'flex', alignItems: 'center', gap: 8,
                color: '#7d8590', fontSize: 11,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#58a6ff', animation: 'pulse 1.5s ease infinite' }} />
                {progress}
                <span onClick={() => { cancelRef.current = true; setLoading(false); setStage('captured') }}
                  style={{ cursor: 'pointer', color: '#f85149', marginLeft: 4 }}>Cancel</span>
              </div>
            )}

            {/* Image container */}
            {isOverlay && selectionViewport && selectionCrop && activeMode.areaSelectTransparent !== false ? (
              /* Transparent area-select mode: only show the cropped selection, rest is transparent */
              <div style={{
                position: 'fixed',
                left: selectionViewport.x, top: selectionViewport.y,
                width: selectionViewport.w, height: selectionViewport.h,
                borderRadius: 4, overflow: 'hidden',
                border: '2px solid rgba(88,166,255,0.4)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
              }}>
                <img src={selectionCrop.dataUrl} alt="Selection" style={{
                  display: 'block', width: '100%', height: '100%', objectFit: 'fill',
                }} />
                {/* Word overlays positioned within the crop */}
                {stage === 'done' && ocrWords.length > 0 && (
                  <div style={{ position: 'absolute', inset: 0 }}>
                    {renderWordOverlays(true)}
                  </div>
                )}
              </div>
            ) : (
            <div
              style={isOverlay
                ? (areaSelectBounds && pinnedIdx !== null)
                  ? { position: 'fixed', overflow: 'hidden',
                      left: areaSelectBounds.x, top: areaSelectBounds.y,
                      width: areaSelectBounds.width, height: areaSelectBounds.height,
                      background: '#000', borderRadius: 4,
                      border: '2px solid rgba(88,166,255,0.4)',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }
                  : areaSelectBounds
                    ? { position: 'relative', overflow: 'hidden', width: '100%', height: '100%', background: '#000',
                        borderRadius: 4, border: '2px solid rgba(88,166,255,0.4)' }
                    : { position: 'relative', overflow: 'hidden', width: '100vw', height: '100vh', background: '#000' }
                : S.imageContainer}
              onClick={() => !isOverlay && stage === 'done' && ocrWords.length > 0 && setExpanded(true)}
            >
              <img src={screenshot} alt="Screenshot" style={isOverlay
                ? { display: 'block', width: '100%', height: '100%', objectFit: 'fill' }
                : S.mainImage} />

              {/* Word overlays */}
              {stage === 'done' && ocrWords.length > 0 && (
                <div style={S.overlayLayer}>{renderWordOverlays()}</div>
              )}

              {/* Analyze button overlay */}
              {stage === 'captured' && !loading && !isOverlay && (
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

            </div>
            )}
              {/* Expand hint (below image, hidden in overlay) */}
              {stage === 'done' && ocrWords.length > 0 && !isOverlay && (
                <div style={{ color: '#7d8590', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 6 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Click to expand & hover words
                </div>
              )}

            {/* Stats bar */}
            {stage === 'done' && !isOverlay && (
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

      {/* ── Chat Side Panel (split-screen) ──────────────────────────────────── */}
      {false && (
        <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 380, background: '#0e1117', borderLeft: '1px solid #2a3040', zIndex: 9000, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3040', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>Chat</span>
            <button onClick={() => setChatSidePanel(false)} style={{ ...S.ghostBtn, fontSize: 10, padding: '2px 8px' }}>&times;</button>
          </div>
          {chatTabAttachedDeck && (
            <div style={{ padding: '4px 12px', borderBottom: '1px solid #2a3040', fontSize: 10, color: '#58a6ff', display: 'flex', alignItems: 'center', gap: 4 }}>
              Attached: {chatTabAttachedDeck.name} ({chatTabAttachedDeck.cards.length} cards)
              <span onClick={() => setChatTabAttachedDeck(null)} style={{ cursor: 'pointer', color: '#7d8590' }}>&times;</span>
            </div>
          )}
          <div ref={chatTabScrollRef} style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
            {chatTabMsgs.length === 0 && <div style={{ textAlign: 'center', color: '#484f58', fontSize: 11, padding: 20 }}>Start a conversation...</div>}
            {chatTabMsgs.map((m, i) => (
              <div key={i} style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '90%', padding: '8px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.4, background: m.role === 'user' ? 'rgba(88,166,255,.12)' : '#1c2129', border: `1px solid ${m.role === 'user' ? 'rgba(88,166,255,.2)' : '#2a3040'}`, color: '#e6edf3', whiteSpace: 'pre-wrap' }}>
                  {m.content}
                </div>
                {m.cards?.map((card, ci) => (
                  <div key={ci} style={{ maxWidth: '90%', marginTop: 4, padding: '8px 10px', borderRadius: 6, background: '#161b22', border: '1px solid #2a3040', fontSize: 11 }}>
                    <div style={{ fontWeight: 600, color: '#e6edf3', marginBottom: 2 }}>{card.front}</div>
                    <div style={{ color: '#c9d1d9', whiteSpace: 'pre-line', marginBottom: 4 }}>{card.back}</div>
                    {card.synced ? <span style={{ fontSize: 9, color: '#7ee787' }}>Synced</span> : (
                      <button onClick={() => chatTabSyncCard(card, i)} style={{ ...S.ghostBtn, fontSize: 9, padding: '2px 8px', color: '#7ee787', borderColor: 'rgba(126,231,135,.3)' }}>Sync to Anki</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {chatTabLoading && <div style={{ fontSize: 11, color: chatTabStatus === 'searching' ? '#58a6ff' : '#7d8590', padding: '4px 0' }}>
              {chatTabStatus === 'searching' ? 'Searching the web...' : chatTabStatus === 'search-done' ? 'Analyzing results...' : 'Thinking...'}
            </div>}
          </div>
          <div style={{ padding: '8px 12px', borderTop: '1px solid #2a3040' }}>
            {!chatTabAttachedDeck && ankiConnected && (
              <select value="" onChange={(e) => { if (e.target.value) chatTabAttachDeck(e.target.value) }} style={{ ...S.select, fontSize: 9, padding: '2px 4px', marginBottom: 4, width: '100%' }}>
                <option value="">Attach deck...</option>
                {ankiDecks.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            <div style={{ display: 'flex', gap: 4 }}>
              <input value={chatTabInput} onChange={(e) => setChatTabInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatTabMessage() } }} placeholder="Ask anything..." style={{ ...S.keyInput, flex: 1, fontSize: 11, padding: '8px 10px' }} disabled={chatTabLoading} />
              <button onClick={sendChatTabMessage} disabled={chatTabLoading || !chatTabInput.trim()} style={{ ...S.captureBtn, borderRadius: 4, fontSize: 10, opacity: chatTabLoading || !chatTabInput.trim() ? 0.5 : 1 }}>Send</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tooltip ──────────────────────────────────────────────────────────── */}
      {activeWord && (() => {
        const hasExpanded = isPinned && (deepExplanation || wordStudy || chatMessages.length > 0)
        const hoverTransform = tooltipPos.anchor === 'below'
          ? 'translate(-50%, 0)' // tooltip below word
          : 'translate(-50%, -100%)' // tooltip above word (default)
        const pinnedStyle = isPinned && pinnedTooltipPos
          ? { ...S.tooltip, ...S.tooltipExpanded,
              left: pinnedTooltipPos.x, top: pinnedTooltipPos.y, transform: 'none',
              ...(hasExpanded ? { maxWidth: 900, width: 500 } : { maxWidth: 400, width: 'auto', minWidth: 300 }),
            }
          : isPinned
            ? { ...S.tooltip, ...S.tooltipExpanded, ...(hasExpanded ? { maxWidth: 900, width: '92vw' } : { maxWidth: 400, width: 'auto' }) }
            : null
        const tooltipStyle = pinnedStyle || { ...S.tooltip, left: tooltipPos.x, top: tooltipPos.y, transform: hoverTransform }
        return (
        <>
        {isPinned && !isOverlay && (
          <div style={S.tooltipBackdrop} onClick={dismissPin} />
        )}
        <div data-tooltip-pinned={isPinned || undefined} style={tooltipStyle} onClick={(e) => e.stopPropagation()}>
          {/* Drag handle for pinned tooltip */}
          {isPinned && (
            <div
              onMouseDown={handleTooltipDragStart}
              style={{ cursor: 'grab', padding: '2px 0 4px', display: 'flex', justifyContent: 'center', userSelect: 'none' }}
            >
              <div style={{ width: 32, height: 4, borderRadius: 2, background: '#3a4050' }} />
            </div>
          )}
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
          {activeWord.translation && (
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div style={S.ttAnkiCardLabel}>Front</div>
                    <button
                      onClick={() => {
                        if (ankiEditing) {
                          setAnkiCard({ ...ankiCard, front: ankiEditFront, back: ankiEditBack })
                          setAnkiEditing(false)
                        } else {
                          setAnkiEditFront(ankiCard.front)
                          setAnkiEditBack(ankiCard.back)
                          setAnkiEditing(true)
                        }
                      }}
                      style={{ background: 'none', border: '1px solid #2a3040', color: ankiEditing ? '#7ee787' : '#7d8590', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {ankiEditing ? 'Save' : 'Edit'}
                    </button>
                  </div>
                  {ankiEditing ? (
                    <textarea
                      value={ankiEditFront}
                      onChange={(e) => setAnkiEditFront(e.target.value)}
                      style={{ ...S.ttAnkiCardContent, width: '100%', minHeight: 36, resize: 'vertical', background: '#161b22', color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    />
                  ) : (
                    <div style={S.ttAnkiCardContent}>{ankiCard.front}</div>
                  )}
                  <div style={S.ttAnkiCardLabel}>Back</div>
                  {ankiEditing ? (
                    <textarea
                      value={ankiEditBack}
                      onChange={(e) => setAnkiEditBack(e.target.value)}
                      style={{ ...S.ttAnkiCardContent, width: '100%', minHeight: 80, resize: 'vertical', background: '#161b22', color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'pre-line', boxSizing: 'border-box' }}
                    />
                  ) : (
                    <div style={{ ...S.ttAnkiCardContent, whiteSpace: 'pre-line', marginBottom: 4 }}>{ankiCard.back}</div>
                  )}
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
                  {/* AI refine input */}
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="text"
                        value={ankiRefineInput}
                        onChange={(e) => setAnkiRefineInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') refineAnkiCard() }}
                        placeholder='e.g. "Say football instead of soccer"'
                        style={{ flex: 1, background: '#161b22', color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 4, padding: '4px 8px', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
                      />
                      <button
                        onClick={refineAnkiCard}
                        disabled={ankiRefining || !ankiRefineInput.trim()}
                        style={{ background: 'rgba(136,98,255,.15)', color: '#a78bfa', border: '1px solid rgba(136,98,255,.3)', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', opacity: (ankiRefining || !ankiRefineInput.trim()) ? 0.4 : 1 }}
                      >
                        {ankiRefining ? 'Refining...' : 'Refine'}
                      </button>
                    </div>
                  </div>
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

      {/* Floating AI Help Button */}
      {!isOverlay && <HelpChat apiKey={apiKey} appContext={{
        activeTab,
        activeMode: { name: activeMode.name, type: activeMode.type, ankiDeck: activeMode.ankiDeck },
        ocrWords: ocrWords.map(w => ({ text: w.text, translation: w.translation })),
        activeWord: activeWord ? { text: activeWord.text, translation: activeWord.translation, pronunciation: activeWord.pronunciation, definition: activeWord.definition, synonyms: activeWord.synonyms, example: activeWord.example } : null,
        explanation,
        deepExplanation,
        ankiConnected,
        ankiDecks,
        ankiCard,
        studyActive,
        studyDeck,
        studyPhase,
        studyStats,
        studyDeckStats,
        currentQuestion: studyActive && studyQueue[studyQueueIdx] ? { question: studyQueue[studyQueueIdx].question, cardFront: studyCardState[studyQueue[studyQueueIdx].cardIdx]?.front } : null,
        chatTabMsgs: chatTabMsgs.slice(-5).map(m => ({ role: m.role, content: m.content?.slice(0, 200) })),
        language,
        targetLang,
        screenshot: !!screenshot,
        stage,
      }} />}
    </div>
  )
}

