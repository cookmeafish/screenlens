import { useState, useRef, useCallback, useEffect } from 'react'
import Tesseract from 'tesseract.js'
import { TRANSLATE_PROMPT, POS_COLORS, CATEGORY_COLORS } from './config/prompts'
import { PROVIDERS } from './config/providers'
import { LANGS } from './config/languages'
import FormattedText from './components/FormattedText'
import { S } from './styles/theme'


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

      // Step 2: Detect if background is dark (average brightness)
      let totalBrightness = 0
      const pixelCount = d.length / 4
      for (let i = 0; i < d.length; i += 4) totalBrightness += d[i]
      const avgBrightness = totalBrightness / pixelCount
      const isDark = avgBrightness < 128

      // Step 3: Contrast enhancement (stronger for dark images)
      const factor = isDark ? 2.2 : 1.5
      for (let i = 0; i < d.length; i += 4) {
        const val = (d[i] - 128) * factor + 128
        d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, val))
      }

      // Step 4: Adaptive thresholding (local neighborhood comparison)
      // Use a simplified approach: compare each pixel to its local average
      const w = c.width, h = c.height
      const gray = new Uint8Array(pixelCount)
      for (let i = 0; i < pixelCount; i++) gray[i] = d[i * 4]

      const blockSize = Math.max(15, Math.round(Math.min(w, h) / 50) | 1) // odd number
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
          // Pixel is text if it's significantly different from local mean
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

  const fileInputRef = useRef(null)
  const containerRef = useRef(null)

  const apiKey = apiKeys[provider] || ''
  const providerConfig = PROVIDERS[provider]

  // ─── Load Keys & Config from file on mount ─────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch('/api/keys').then((r) => r.json()).catch(() => ({})),
      fetch('/api/config').then((r) => r.json()).catch(() => ({})),
    ]).then(([keys, config]) => {
      setApiKeys(keys)
      if (config.provider) setProvider(config.provider)
      if (config.language) setLanguage(config.language)
      if (config.targetLang) setTargetLang(config.targetLang)
      if (config.showHighlights !== undefined) setShowHighlights(config.showHighlights)
      setKeysLoaded(true)
      setConfigLoaded(true)
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

      // Downscale for OCR if wider than 1920px (speeds up Tesseract, display stays full-res)
      let ocrInput = dataUrl
      if (imgDims.w > 1920) {
        const scale = 1920 / imgDims.w
        const c = document.createElement('canvas')
        c.width = 1920
        c.height = Math.round(imgDims.h * scale)
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
      const bboxScale = imgDims.w > 1920 ? imgDims.w / 1920 : 1
      const rawWords = (result.data.words || [])
        .filter((w) => {
          const t = w.text.trim()
          if (t.length === 0) return false
          // Must contain at least one letter
          if (!/[a-zA-ZÀ-ÿ]/.test(t)) return false
          // Count actual letters (not symbols/digits)
          const letterCount = (t.match(/[a-zA-ZÀ-ÿ]/g) || []).length
          if (letterCount === 0) return false
          // Short words need higher confidence to avoid noise
          const minConf = letterCount === 1 ? 85 : t.length <= 2 ? 70 : t.length <= 3 ? 45 : 25
          if (w.confidence < minConf) return false
          return true
        })
        .map((w) => ({
          text: w.text.trim(),
          bbox: {
            x0: Math.round(w.bbox.x0 * bboxScale),
            y0: Math.round(w.bbox.y0 * bboxScale),
            x1: Math.round(w.bbox.x1 * bboxScale),
            y1: Math.round(w.bbox.y1 * bboxScale),
          },
          confidence: w.confidence,
        }))

      // Merge adjacent fragments that are very close horizontally (same word split by color/style)
      const merged = []
      for (let j = 0; j < rawWords.length; j++) {
        const w = rawWords[j]
        if (merged.length > 0) {
          const prev = merged[merged.length - 1]
          const gap = w.bbox.x0 - prev.bbox.x1
          const avgHeight = ((prev.bbox.y1 - prev.bbox.y0) + (w.bbox.y1 - w.bbox.y0)) / 2
          const sameRow = Math.abs(w.bbox.y0 - prev.bbox.y0) < avgHeight * 0.5
          // If gap is very small (< 30% of char height) and same row, merge
          if (sameRow && gap >= 0 && gap < avgHeight * 0.3) {
            prev.text += w.text
            prev.bbox.x1 = w.bbox.x1
            prev.bbox.y0 = Math.min(prev.bbox.y0, w.bbox.y0)
            prev.bbox.y1 = Math.max(prev.bbox.y1, w.bbox.y1)
            prev.confidence = Math.min(prev.confidence, w.confidence)
            continue
          }
        }
        merged.push({ ...w, bbox: { ...w.bbox } })
      }
      const finalWords = merged

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

        console.log('[ScreenLens] Chunk', i, 'sent:', indexedWords.length, 'words')
        console.log('[ScreenLens] AI returned:', text.slice(0, 300))

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
            console.error('[ScreenLens] JSON repair failed:', e2.message, '\nRaw:', text.slice(0, 500))
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

      // ── Quick gap check: fill any missing indices ──────────────────────────
      const missing = []
      for (let i = 0; i < finalWords.length; i++) {
        if (!allTranslations[String(i)]) {
          allTranslations[String(i)] = { t: 'Loading…', s: [], e: false, _untranslated: true }
          missing.push(i)
        }
      }
      if (missing.length > 0) {
        console.warn(`[ScreenLens] ${missing.length} words had no translation, will translate on hover:`, missing.map((i) => finalWords[i].text))
      }

      // ── Merge OCR + Translation (matched by index, can't shift) ─────────────
      const translatedWords = finalWords.map((w, i) => {
        const t = allTranslations[String(i)]
        // Backward compat: map old e:true to category 'target'
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

      setOcrWords(translatedWords)
      setStage('done')

      // Auto-retry any missed words in background
      if (missing.length > 0) {
        missing.forEach((idx) => lazyTranslate(idx))
      }
    } catch (err) {
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

  // ─── Drag & Drop ───────────────────────────────────────────────────────────
  const handleDragOver = (e) => { e.preventDefault(); setDragging(true) }
  const handleDragLeave = (e) => {
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget)) setDragging(false)
  }
  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false)
    if (e.dataTransfer?.files?.[0]) loadImageFromFile(e.dataTransfer.files[0])
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
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top - 6 })
    // If this word wasn't translated, translate it now
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
      setChatMessages([])
      setChatInput('')
      const rect = e.currentTarget.getBoundingClientRect()
      setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top - 6 })
      // Auto-trigger short explanation
      const word = ocrWords[idx]
      if (word) {
        autoExplain(word)
      }
    }
  }

  const dismissPin = () => {
    setPinnedIdx(null)
    setExplanation(null)
    setDeepExplanation(null)
    setWordStudy(null); setConjugation(null)
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
      const prompt = `Word: "${word.text}" (translated: "${word.translation}")
Context: "${getContext()}"

In 1-2 short sentences: what does "${word.text}" mean here and what part of speech is it? No markdown.`
      const text = await providerConfig.call(apiKey, 'You are a concise language tutor. Answer in 1-2 sentences max.', prompt)
      setExplanation(text)
    } catch (err) {
      setExplanation('Failed: ' + err.message)
    } finally {
      setExplaining(false)
    }
  }, [apiKey, ocrWords, providerConfig])

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
    return ocrWords.map((word, i) => {
      const x = (word.bbox.x0 / imgDims.w) * 100
      const y = (word.bbox.y0 / imgDims.h) * 100
      const w = ((word.bbox.x1 - word.bbox.x0) / imgDims.w) * 100
      const h = ((word.bbox.y1 - word.bbox.y0) / imgDims.h) * 100
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
      {dragging && (
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
      <header style={S.header}>
        <div style={S.headerLeft}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="3" width="20" height="18" rx="2" stroke="#58a6ff" strokeWidth="2"/>
            <circle cx="18" cy="7" r="4" fill="#58a6ff"/>
          </svg>
          <h1 style={S.title}>ScreenLens</h1>
          <span style={S.badge}>LOCAL</span>
        </div>
        <div style={S.headerRight}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#1c2129', border: '1px solid #2a3040', borderRadius: 6, padding: '2px 4px' }}>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...S.select, border: 'none', background: 'transparent', padding: '4px 6px' }}>
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <span style={{ color: '#58a6ff', fontSize: 14, fontWeight: 700 }}>→</span>
            <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)} style={{ ...S.select, border: 'none', background: 'transparent', padding: '4px 6px' }}>
              {LANGS.filter((l) => l.code !== 'auto').map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>

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

          <kbd style={S.kbd}>Ctrl+Shift+S</kbd>
        </div>
      </header>

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

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <main style={S.main}>
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
      </main>

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
        const tooltipStyle = isPinned
          ? { ...S.tooltip, ...S.tooltipExpanded, ...(hasExpanded ? { maxWidth: 900, width: '92vw' } : { maxWidth: 400, width: 'auto' }) }
          : { ...S.tooltip, left: tooltipPos.x, top: tooltipPos.y }
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

          {/* Pinned: short explanation (auto-loaded) */}
          {isPinned && (
            <div style={S.ttActions}>
              {explaining && (
                <div style={S.ttExplaining}>
                  <div style={S.ttExplainingDot} />
                  Thinking...
                </div>
              )}
              {explanation && (
                <div style={S.ttExplanation}>{explanation}</div>
              )}

              {/* Action buttons row */}
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

