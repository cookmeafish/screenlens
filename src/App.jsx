import { useState, useRef, useCallback, useEffect } from 'react'
import Tesseract from 'tesseract.js'

// ─── Translation Prompt (shared across providers) ───────────────────────────
const TRANSLATE_PROMPT = `Translate words from a foreign language to English.

You receive JSON: {"words": [{"i":0,"w":"word1"},{"i":1,"w":"word2"},...], "lang": "Spanish", "context": "..."}

Each word has an index "i" and the word text "w". Translate each word to English using context.

Return a JSON array. For each input word, return an object that includes:
- "i": the SAME index number from the input (MUST match)
- "w": the SAME original word from the input (MUST match)
- "t": English translation (MUST be English, not the original word)
- "s": 2-3 English synonyms (empty array for articles/prepositions/punctuation)
- "e": false if source language, true only if genuinely English

CRITICAL: Every output object MUST include "i" and "w" copied exactly from the input.

Words with punctuation attached (e.g. "púas,") — translate the word part, ignore punctuation.

Output ONLY the raw JSON array. No markdown, no backticks.

Example:
Input: {"words":[{"i":0,"w":"Aventura"},{"i":1,"w":"en"},{"i":2,"w":"el"}],"lang":"Spanish","context":"Aventura en el laberinto"}
Output: [{"i":0,"w":"Aventura","t":"Adventure","s":["quest","journey"],"e":false},{"i":1,"w":"en","t":"in","s":[],"e":false},{"i":2,"w":"el","t":"the","s":[],"e":false}]`

// ─── AI Provider Configurations ─────────────────────────────────────────────
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    placeholder: 'sk-ant-...',
    keyPrefix: 'sk-ant-',
    color: '#d2a8ff',
    url: 'https://console.anthropic.com/settings/keys',
    billingUrl: 'https://console.anthropic.com/settings/plans',
    model: 'claude-haiku-4-5-20251001',
    call: async (apiKey, systemPrompt, userContent) => {
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
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      return data.content?.map((c) => (c.type === 'text' ? c.text : '')).join('')
    },
  },
  openai: {
    label: 'OpenAI (GPT)',
    placeholder: 'sk-...',
    keyPrefix: 'sk-',
    color: '#74aa9c',
    url: 'https://platform.openai.com/api-keys',
    billingUrl: 'https://platform.openai.com/settings/organization/billing',
    model: 'gpt-4o-mini',
    call: async (apiKey, systemPrompt, userContent) => {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 4000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      return data.choices?.[0]?.message?.content || ''
    },
  },
  gemini: {
    label: 'Google (Gemini)',
    placeholder: 'AIza...',
    keyPrefix: 'AIza',
    color: '#4285f4',
    url: 'https://aistudio.google.com/apikey',
    billingUrl: 'https://aistudio.google.com/apikey',
    model: 'gemini-2.0-flash',
    call: async (apiKey, systemPrompt, userContent) => {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userContent }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
      )
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || ''
    },
  },
  grok: {
    label: 'xAI (Grok)',
    placeholder: 'xai-...',
    keyPrefix: 'xai-',
    color: '#e6e6e6',
    url: 'https://console.x.ai/',
    billingUrl: 'https://console.x.ai/',
    model: 'grok-3-mini-fast',
    call: async (apiKey, systemPrompt, userContent) => {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-3-mini-fast',
          max_tokens: 4000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      return data.choices?.[0]?.message?.content || ''
    },
  },
}

// ─── Available OCR Languages ─────────────────────────────────────────────────
const LANGS = [
  { code: 'auto', label: 'Detect Language' },
  { code: 'spa', label: 'Spanish' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'por', label: 'Portuguese' },
  { code: 'ita', label: 'Italian' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'rus', label: 'Russian' },
  { code: 'ara', label: 'Arabic' },
  { code: 'hin', label: 'Hindi' },
  { code: 'tha', label: 'Thai' },
  { code: 'vie', label: 'Vietnamese' },
  { code: 'pol', label: 'Polish' },
  { code: 'nld', label: 'Dutch' },
  { code: 'eng', label: 'English' },
]

// ─── Formatted Text Renderer ────────────────────────────────────────────────
function FormattedText({ text, accentColor = '#58a6ff' }) {
  if (!text) return null
  // Split into sections by numbered headers (1. Title:, **1. Title:**) or ALL-CAPS headers
  const lines = text.split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (current) current.lines.push('')
      continue
    }
    // Match patterns like "1. Title:", "**1. Title:**", "TITLE:", "**TITLE**"
    const headerMatch = trimmed.match(
      /^(?:\*{0,2})?\s*(?:\d+\.\s*)?([A-Z][A-Z\s/&]+(?:FORM|WORDS|USAGE|SENTENCES|PATTERNS|REGISTER|CONJUGATIONS|EXPLANATION|MEANING|SPEECH|ROOT|INFINITIVE|RELATED|REGIONAL|EXAMPLE)[A-Z\s/&]*?)\s*[:*]*\s*(?:\*{0,2})?(.*)$/
    ) || trimmed.match(
      /^(?:\*{0,2})\s*\d+\.\s*([^*:]+?)\s*[:*]+\s*(?:\*{0,2})?\s*(.*)$/
    )

    if (headerMatch) {
      current = { title: headerMatch[1].trim().replace(/\*+/g, ''), lines: [] }
      sections.push(current)
      if (headerMatch[2]?.trim()) current.lines.push(headerMatch[2].trim())
    } else {
      if (!current) {
        current = { title: null, lines: [] }
        sections.push(current)
      }
      current.lines.push(trimmed)
    }
  }

  return (
    <div>
      {sections.map((section, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          {section.title && (
            <div style={{
              fontSize: 13, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '.08em', color: accentColor, marginBottom: 6,
              paddingBottom: 4, borderBottom: `1px solid ${accentColor}33`,
            }}>
              {section.title}
            </div>
          )}
          <div style={{ fontSize: 14, color: '#c9d1d9', lineHeight: 1.8 }}>
            {section.lines.map((line, j) => {
              if (!line) return <div key={j} style={{ height: 6 }} />
              // Format bullet points and dashes
              const isBullet = /^[-•–]/.test(line)
              const isExample = /^[""]/.test(line) || /ejemplo|example|translation/i.test(line)
              return (
                <div key={j} style={{
                  paddingLeft: isBullet ? 12 : 0,
                  fontStyle: isExample ? 'italic' : 'normal',
                  color: isExample ? '#8b949e' : '#c9d1d9',
                  marginBottom: 2,
                }}>
                  {line}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
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
  const [stage, setStage] = useState('idle') // idle | captured | ocr | translating | done
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [showHighlights, setShowHighlights] = useState(true)
  const [language, setLanguage] = useState('auto')

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
      body: JSON.stringify({ provider, language, showHighlights }),
    }).catch(() => {})
  }, [provider, language, showHighlights, configLoaded])

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
        .filter((w) => w.text.trim().length > 0 && w.confidence > 15)
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

      if (rawWords.length === 0) {
        setError('No readable text found. Try a different language or a clearer screenshot.')
        setStage('captured')
        setLoading(false)
        return
      }

      // ── Stage 2: AI Translation ────────────────────────────────────────────
      setStage('translating')
      setProgress(`Found ${rawWords.length} words. Translating…`)

      const wordTexts = rawWords.map((w) => w.text)
      const fullContext = wordTexts.join(' ')
      const chunkSize = 80
      const allTranslations = {} // globalIndex → { t, s, e }

      for (let i = 0; i < wordTexts.length; i += chunkSize) {
        const chunk = wordTexts.slice(i, i + chunkSize)
        const chunkEnd = Math.min(i + chunkSize, wordTexts.length)
        setProgress(`Translating ${i + 1}–${chunkEnd} of ${wordTexts.length}…`)

        // Build array of {i, w} objects with global indices
        const indexedWords = chunk.map((word, j) => ({ i: i + j, w: word }))

        const langLabel = language === 'auto' ? 'Auto-detect (figure out the language from context)' : (LANGS.find((l) => l.code === language)?.label || 'Unknown')
        const payload = JSON.stringify({ words: indexedWords, lang: langLabel, context: fullContext })
        const text = await providerConfig.call(apiKey, TRANSLATE_PROMPT, payload)
        if (!text) throw new Error('Empty translation response')

        console.log('[ScreenLens] Chunk', i, 'sent:', indexedWords.length, 'words')
        console.log('[ScreenLens] AI returned:', text.slice(0, 300))

        let cleaned = text.replace(/```json|```/g, '').trim()
        let parsed
        try {
          parsed = JSON.parse(cleaned)
        } catch {
          let r = cleaned
          if ((r.match(/"/g) || []).length % 2 !== 0) r += '"'
          r = r.replace(/,\s*$/, '')
          let ob = (r.match(/\[/g) || []).length - (r.match(/\]/g) || []).length
          let oc = (r.match(/\{/g) || []).length - (r.match(/\}/g) || []).length
          for (; ob > 0; ob--) r += ']'
          for (; oc > 0; oc--) r += '}'
          parsed = JSON.parse(r)
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
      for (let i = 0; i < rawWords.length; i++) {
        if (!allTranslations[String(i)]) {
          allTranslations[String(i)] = { t: 'Loading…', s: [], e: false, _untranslated: true }
          missing.push(i)
        }
      }
      if (missing.length > 0) {
        console.warn(`[ScreenLens] ${missing.length} words had no translation, will translate on hover:`, missing.map((i) => rawWords[i].text))
      }

      // ── Merge OCR + Translation (matched by index, can't shift) ─────────────
      const merged = rawWords.map((w, i) => {
        const t = allTranslations[String(i)]
        return {
          text: w.text,
          bbox: w.bbox,
          confidence: w.confidence,
          translation: t.t || w.text,
          synonyms: t.s || [],
          isEnglish: t.e === true,
          _untranslated: t._untranslated || false,
        }
      })

      setOcrWords(merged)
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
  }, [apiKey, language, providerConfig])

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
      const langLabel = language === 'auto' ? 'Auto-detect' : (LANGS.find((l) => l.code === language)?.label || 'Unknown')
      const payload = JSON.stringify({ words: [{ i: idx, w: word.text }], lang: langLabel, context })
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
      setWordStudy(null)
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
    setWordStudy(null)
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
    setWordStudy(null)
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
              ? isPinned ? 'rgba(88, 166, 255, 0.45)' : 'rgba(210, 168, 255, 0.45)'
              : showHighlights && !word.isEnglish
                ? 'rgba(210, 168, 255, 0.12)'
                : 'transparent',
            border: isActive
              ? isPinned ? '2px solid rgba(88, 166, 255, 0.85)' : '2px solid rgba(210, 168, 255, 0.85)'
              : showHighlights && !word.isEnglish
                ? '1px solid rgba(210, 168, 255, 0.2)'
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
          <select value={language} onChange={(e) => setLanguage(e.target.value)} style={S.select}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>

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
          <div style={{ animation: 'fadeUp 0.25s ease' }}>
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
        const tooltipStyle = hasExpanded
          ? { ...S.tooltip, ...S.tooltipExpanded }
          : { ...S.tooltip, left: tooltipPos.x, top: tooltipPos.y, pointerEvents: isPinned ? 'auto' : 'none',
              maxHeight: isPinned ? '60vh' : 'none', overflowY: isPinned ? 'auto' : 'visible' }
        return (
        <>
        {hasExpanded && (
          <div style={S.tooltipBackdrop} onClick={dismissPin} />
        )}
        <div style={tooltipStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={S.ttWord}>{activeWord.text}</div>
            {isPinned && (
              <span onClick={dismissPin} style={S.ttClose}>&times;</span>
            )}
          </div>
          {!activeWord.isEnglish && (
            <div style={S.ttTrans}>→ {activeWord.translation}</div>
          )}
          {activeWord.isEnglish && (
            <div style={S.ttEng}>English</div>
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

// ─── Styles ──────────────────────────────────────────────────────────────────
const S = {
  app: {
    minHeight: '100vh', background: '#0e1117', color: '#e6edf3',
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    display: 'flex', flexDirection: 'column', position: 'relative',
  },

  // Header
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 20px', borderBottom: '1px solid #2a3040',
    background: '#161b22', flexWrap: 'wrap', gap: 8,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  title: { fontSize: 16, fontWeight: 700, margin: 0 },
  badge: {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7ee787', background: 'rgba(126,231,135,.12)',
    padding: '2px 7px', borderRadius: 3,
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  select: {
    padding: '6px 10px', background: '#1c2129', color: '#e6edf3',
    border: '1px solid #2a3040', borderRadius: 6, fontSize: 11,
    fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
  },
  ghostBtn: {
    padding: '6px 12px', background: 'transparent', color: '#7d8590',
    border: '1px solid #2a3040', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
  },
  captureGroup: { display: 'flex', gap: 0 },
  captureBtn: {
    padding: '7px 14px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: '6px 0 0 6px', fontWeight: 700,
    fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    display: 'flex', alignItems: 'center',
  },
  uploadBtn: {
    padding: '7px 14px', background: '#3a7bd5', color: '#0e1117',
    border: 'none', borderRadius: '0 6px 6px 0', fontWeight: 700,
    fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    borderLeft: '1px solid rgba(14,17,23,.3)',
  },
  kbd: {
    fontSize: 10, color: '#7d8590', background: '#1c2129',
    border: '1px solid #2a3040', borderRadius: 4, padding: '3px 8px',
    fontFamily: 'inherit',
  },
  kbdInline: {
    fontSize: '0.85em', color: '#7d8590', background: '#1c2129',
    border: '1px solid #2a3040', borderRadius: 3, padding: '1px 5px',
    fontFamily: 'inherit',
  },

  // API Key bar
  keyBar: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px',
    background: '#1c2129', borderBottom: '1px solid #2a3040', flexWrap: 'wrap',
  },
  keyLabel: { fontSize: 12, color: '#7d8590', fontWeight: 600 },
  keyInput: {
    flex: 1, minWidth: 200, padding: '6px 10px', background: '#0e1117',
    color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 6,
    fontSize: 12, fontFamily: 'inherit', outline: 'none',
  },
  getKeyLink: {
    padding: '6px 12px', background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    border: '1px solid rgba(88,166,255,.25)', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  keyDone: {
    padding: '6px 14px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 12,
    fontFamily: 'inherit', cursor: 'pointer',
  },

  // Main
  main: { flex: 1, padding: 20, overflow: 'auto' },

  // Empty state
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: '65vh', textAlign: 'center',
  },
  emptyTitle: { fontSize: 22, fontWeight: 600, margin: '0 0 10px' },
  emptyDesc: {
    fontSize: 13, color: '#7d8590', maxWidth: 520, lineHeight: 1.7, margin: 0,
  },
  methods: { display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' },
  methodCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    padding: '18px 28px', borderRadius: 10, border: '1px solid',
    background: '#161b22', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  },

  // Error
  errorBar: {
    background: 'rgba(248,81,73,.1)', border: '1px solid #f85149',
    color: '#f85149', padding: '12px 16px', borderRadius: 6,
    fontSize: 13, marginBottom: 16,
  },
  errorActions: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap',
  },
  errorLink: {
    padding: '6px 14px', background: '#f85149', color: '#fff',
    borderRadius: 6, fontWeight: 700, fontSize: 12, textDecoration: 'none',
    fontFamily: 'inherit',
  },
  errorSwitchBtn: {
    padding: '6px 12px', background: 'transparent', color: '#7d8590',
    border: '1px solid #2a3040', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
  },

  // Progress
  progressBar: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
    background: '#161b22', border: '1px solid #2a3040', borderRadius: 8, marginBottom: 12,
  },
  progressDot: {
    width: 12, height: 12, borderRadius: '50%', background: '#58a6ff',
    animation: 'pulse 1.5s ease infinite', flexShrink: 0,
  },
  progressText: { fontSize: 12, color: '#7d8590' },

  // Image
  imageContainer: {
    position: 'relative', borderRadius: 10, overflow: 'hidden',
    border: '1px solid #2a3040', cursor: 'pointer', background: '#000',
    display: 'inline-block', maxWidth: '100%',
  },
  mainImage: { display: 'block', maxWidth: '100%', maxHeight: '75vh', height: 'auto', width: 'auto' },
  overlayLayer: { position: 'absolute', inset: 0 },
  capturedOverlay: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(14,17,23,.55)',
    backdropFilter: 'blur(2px)',
  },
  bigBtn: {
    display: 'flex', alignItems: 'center', padding: '16px 36px',
    background: '#d2a8ff', color: '#0e1117', border: 'none', borderRadius: 8,
    fontWeight: 700, fontSize: 16, fontFamily: 'inherit', cursor: 'pointer',
    boxShadow: '0 4px 24px rgba(210,168,255,.3)',
  },
  hint: {
    position: 'absolute', bottom: 12, right: 12,
    background: 'rgba(14,17,23,.85)', color: '#7d8590',
    padding: '6px 12px', borderRadius: 6, fontSize: 11,
    display: 'flex', alignItems: 'center', gap: 6,
    border: '1px solid #2a3040', pointerEvents: 'none',
  },

  // Stats
  stats: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' },
  stat: {
    fontSize: 11, color: '#7d8590', background: '#161b22',
    border: '1px solid #2a3040', padding: '4px 10px', borderRadius: 4,
  },

  // Expanded
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(2,4,8,.94)', backdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, cursor: 'pointer', animation: 'fadeIn .2s ease', overflow: 'auto',
  },
  closeBadge: {
    position: 'fixed', top: 16, right: 20, zIndex: 1010,
    color: '#7d8590', fontSize: 13, display: 'flex', alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
  },
  expandedWrap: {
    position: 'relative', maxWidth: '95vw', maxHeight: '92vh',
    cursor: 'default', borderRadius: 8, overflow: 'hidden',
    boxShadow: '0 16px 64px rgba(0,0,0,.6)',
  },
  expandedImg: {
    display: 'block', maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain',
  },

  // Tooltip
  tooltip: {
    position: 'fixed', transform: 'translate(-50%, -100%)',
    background: '#1c2129', border: '1px solid #2a3040',
    borderRadius: 10, padding: '12px 16px', zIndex: 9999,
    boxShadow: '0 12px 40px rgba(0,0,0,.6)',
    minWidth: 170, maxWidth: 300, pointerEvents: 'none',
    animation: 'fadeUp .12s ease',
    fontFamily: "'JetBrains Mono', monospace",
  },
  tooltipBackdrop: {
    position: 'fixed', inset: 0, zIndex: 9998,
    background: 'rgba(2,4,8,.7)', backdropFilter: 'blur(4px)',
  },
  tooltipExpanded: {
    position: 'fixed', left: '50%', top: '50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: 900, width: '92vw', maxHeight: '85vh',
    overflowY: 'auto', pointerEvents: 'auto',
    borderRadius: 12, padding: '24px 32px',
    boxShadow: '0 24px 80px rgba(0,0,0,.8)',
    border: '1px solid #3a4050',
  },
  ttWord: { fontSize: 17, fontWeight: 700, color: '#e6edf3', marginBottom: 2 },
  ttTrans: { fontSize: 14, color: '#58a6ff', fontWeight: 500, marginBottom: 8 },
  ttEng: {
    fontSize: 11, color: '#7ee787', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8,
  },
  ttSynWrap: { borderTop: '1px solid #2a3040', paddingTop: 8 },
  ttSynLabel: {
    fontSize: 9, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7d8590', marginBottom: 6, fontWeight: 600,
  },
  ttSynList: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  ttSynChip: {
    fontSize: 11, background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    padding: '3px 8px', borderRadius: 4, fontWeight: 500,
  },
  ttConf: {
    fontSize: 10, color: '#7d8590', marginTop: 8,
    borderTop: '1px solid #2a3040', paddingTop: 6,
  },
  ttClose: {
    fontSize: 18, color: '#7d8590', cursor: 'pointer', lineHeight: 1,
    padding: '0 2px', marginLeft: 8,
  },
  ttClickHint: {
    fontSize: 10, color: '#484f58', marginTop: 8,
    borderTop: '1px solid #2a3040', paddingTop: 6, textAlign: 'center',
  },
  ttActions: {
    marginTop: 8, borderTop: '1px solid #2a3040', paddingTop: 8,
  },
  ttExplainBtn: {
    display: 'flex', alignItems: 'center', width: '100%',
    padding: '7px 12px', background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    border: '1px solid rgba(88,166,255,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    justifyContent: 'center',
  },
  ttExplaining: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: '#7d8590',
  },
  ttExplainingDot: {
    width: 8, height: 8, borderRadius: '50%', background: '#58a6ff',
    animation: 'pulse 1.5s ease infinite', flexShrink: 0,
  },
  ttExplanation: {
    fontSize: 14, color: '#c9d1d9', lineHeight: 1.7,
    background: 'rgba(88,166,255,.06)', borderRadius: 6,
    padding: '10px 14px', marginTop: 6,
  },
  ttBtnRow: {
    display: 'flex', gap: 6, marginTop: 8,
  },
  ttDeepBtn: {
    flex: 1, padding: '7px 10px', background: 'rgba(210,168,255,.12)', color: '#d2a8ff',
    border: '1px solid rgba(210,168,255,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    textAlign: 'center',
  },
  ttStudyBtn: {
    flex: 1, padding: '7px 10px', background: 'rgba(126,231,135,.12)', color: '#7ee787',
    border: '1px solid rgba(126,231,135,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    textAlign: 'center',
  },
  ttDeepExplanation: {
    fontSize: 14, color: '#c9d1d9', lineHeight: 1.8, whiteSpace: 'pre-wrap',
    background: 'rgba(210,168,255,.04)', border: '1px solid rgba(210,168,255,.12)',
    borderRadius: 8, padding: '14px 18px', marginTop: 8,
  },
  ttWordStudy: {
    marginTop: 8, border: '1px solid rgba(126,231,135,.2)',
    borderRadius: 8, overflow: 'hidden',
  },
  ttWordStudyHeader: {
    fontSize: 12, fontWeight: 700, color: '#7ee787',
    background: 'rgba(126,231,135,.08)', padding: '8px 10px',
    borderBottom: '1px solid rgba(126,231,135,.15)',
  },
  ttWordStudyBody: {
    padding: '14px 16px', background: 'rgba(126,231,135,.03)',
  },
  ttChatSection: {
    marginTop: 8, borderTop: '1px solid #2a3040', paddingTop: 8,
  },
  ttChatLabel: {
    fontSize: 9, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7d8590', marginBottom: 6, fontWeight: 600,
  },
  ttChatUser: {
    fontSize: 12, color: '#e6edf3', background: 'rgba(88,166,255,.1)',
    borderRadius: 6, padding: '6px 10px', marginBottom: 4, textAlign: 'right',
  },
  ttChatAssistant: {
    fontSize: 12, color: '#c9d1d9', background: 'rgba(126,231,135,.06)',
    borderRadius: 6, padding: '6px 10px', marginBottom: 4, lineHeight: 1.5,
  },
  ttChatInputRow: {
    display: 'flex', gap: 4, marginTop: 4,
  },
  ttChatInput: {
    flex: 1, padding: '6px 8px', background: '#0e1117', color: '#e6edf3',
    border: '1px solid #2a3040', borderRadius: 6, fontSize: 11,
    fontFamily: 'inherit', outline: 'none',
  },
  ttChatSend: {
    padding: '6px 10px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 11,
    fontFamily: 'inherit', cursor: 'pointer',
  },

  // Drag overlay
  dragOverlay: {
    position: 'fixed', inset: 0, zIndex: 100,
    background: 'rgba(14,17,23,.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dragBox: {
    border: '2px dashed #58a6ff', borderRadius: 16,
    padding: '48px 64px', display: 'flex',
    flexDirection: 'column', alignItems: 'center',
  },
}
