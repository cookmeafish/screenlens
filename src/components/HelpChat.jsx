import { useState, useRef, useEffect } from 'react'

const HELP_CONTEXT = `You are the ScreenLens Help Assistant. Answer briefly and conversationally — 2-3 sentences max unless the user asks for details. Never use markdown formatting (no **, ##, -, etc). Just plain text. The user can ask follow-up questions.

About ScreenLens:
ScreenLens is an AI-powered screen translation and learning app. It captures screenshots, detects text via OCR, translates it, and integrates with Anki for flashcard study.

Key features:
Capture button / Ctrl+Shift+S: takes a screenshot to analyze.
Upload / paste / drag-drop: alternative ways to load images.
Mode button (toolbar): switch or create learning modes like "Language Learning" or "Security+". Each mode has its own settings.
Gear icon: opens settings for the current mode (Anki deck, card format, tags, study rules, knowledge base).
Study button: starts a quiz session using your Anki flashcards with AI-generated questions.
Deck button: browse, edit, search, and delete Anki flashcards.
Overlay button: launches an Electron overlay for translating game/app screens. Press Ctrl+Shift+S in-game, ESC to dismiss.
Key Set: configure your AI provider API key.
Knowledge Base (in settings): upload reference materials (.txt/.md) for smarter study questions.
Grammar feedback: optional toggle in study settings for grammar correction during quizzes.
Anki integration requires the AnkiConnect addon (code 2055492159) running in Anki desktop.`

export default function HelpChat({ apiKey }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState({ x: 20, y: null })
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const msgTopRef = useRef(null)
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  // Scroll to bottom on any new message (user or assistant)
  useEffect(() => {
    if (msgTopRef.current) {
      setTimeout(() => {
        if (msgTopRef.current) msgTopRef.current.scrollTop = msgTopRef.current.scrollHeight
      }, 50)
    }
  }, [messages])

  // Draggable
  const handleMouseDown = (e) => {
    if (open) return
    setDragging(true)
    const rect = btnRef.current.getBoundingClientRect()
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }
  useEffect(() => {
    if (!dragging) return
    const move = (e) => setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    const up = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [dragging])

  // Call Sonnet directly for better quality
  const sendMessage = async () => {
    if (!input.trim() || loading || !apiKey) return
    const userMsg = input.trim()
    setInput('')
    const newMsgs = [...messages, { role: 'user', text: userMsg }]
    setMessages(newMsgs)
    setLoading(true)

    try {
      const apiMessages = newMsgs.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
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
          max_tokens: 300,
          system: HELP_CONTEXT,
          messages: apiMessages,
        }),
      })
      if (!resp.ok) throw new Error('API ' + resp.status)
      const data = await resp.json()
      setMessages([...newMsgs, { role: 'assistant', text: data.content[0].text }])
    } catch (err) {
      setMessages([...newMsgs, { role: 'assistant', text: 'Error: ' + err.message }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  // Position chat snug to button, opening toward available space
  const getChatStyle = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return {}
    const chatW = 340, chatH = 400
    const btnCX = rect.left + rect.width / 2
    const btnCY = rect.top + rect.height / 2
    const style = { position: 'fixed', width: chatW, maxHeight: chatH }

    // Horizontal: align left edge with button, or right-align if near right edge
    if (btnCX < window.innerWidth / 2) {
      style.left = rect.left
    } else {
      style.left = rect.right - chatW
    }
    style.left = Math.max(5, Math.min(style.left, window.innerWidth - chatW - 5))

    // Vertical: open above button if in bottom half, below if in top half
    if (btnCY > window.innerHeight / 2) {
      // Button is in bottom half — chat goes above, bottom edge snug to button top
      style.bottom = window.innerHeight - rect.top + 8
    } else {
      // Button is in top half — chat goes below, top edge snug to button bottom
      style.top = rect.bottom + 8
    }
    return style
  }

  return (
    <>
      <button
        ref={btnRef}
        onMouseDown={handleMouseDown}
        onClick={() => { if (!dragging) setOpen(!open) }}
        style={{
          position: 'fixed', left: pos.x,
          ...(pos.y !== null ? { top: pos.y } : { bottom: 20 }),
          width: 44, height: 44, borderRadius: '50%',
          background: open ? '#58a6ff' : '#1c2129',
          border: '2px solid #58a6ff',
          color: open ? '#0e1117' : '#58a6ff',
          fontSize: 18, fontWeight: 700,
          cursor: dragging ? 'grabbing' : 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10000, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          fontFamily: 'inherit', transition: 'background 0.15s, color 0.15s',
        }}
        title="Help — ask anything about ScreenLens"
      >
        ?
      </button>

      {open && (() => {
        const chatStyle = getChatStyle()
        return (
          <div style={{
            ...chatStyle,
            background: '#161b22', border: '1px solid #2a3040',
            borderRadius: 10, overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
            zIndex: 10000, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {/* Header */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #2a3040', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff' }}>ScreenLens Help</span>
              <span onClick={() => setOpen(false)} style={{ cursor: 'pointer', color: '#7d8590', fontSize: 16, lineHeight: 1 }}>&times;</span>
            </div>

            {/* Messages */}
            <div ref={msgTopRef} style={{ flex: 1, overflow: 'auto', padding: '10px 14px' }}>
              {messages.length === 0 && (
                <div style={{ color: '#484f58', fontSize: 11, textAlign: 'center', padding: '30px 10px', lineHeight: 1.6 }}>
                  Ask anything about ScreenLens!<br />
                  "What does Study do?"<br />
                  "How do I use the overlay?"
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} data-msg style={{
                  marginBottom: 8, padding: '8px 10px', borderRadius: 6,
                  background: m.role === 'user' ? 'rgba(88,166,255,.1)' : 'rgba(126,231,135,.05)',
                  border: m.role === 'user' ? '1px solid rgba(88,166,255,.15)' : '1px solid rgba(126,231,135,.1)',
                  fontSize: 12, color: '#c9d1d9', lineHeight: 1.6,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {m.text}
                </div>
              ))}
              {loading && (
                <div style={{ fontSize: 11, color: '#7d8590', padding: '4px 10px' }}>Thinking...</div>
              )}
            </div>

            {/* Input */}
            <div style={{ padding: '8px 10px', borderTop: '1px solid #2a3040', display: 'flex', gap: 6, flexShrink: 0 }}>
              <input
                ref={inputRef}
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendMessage() }}
                placeholder={apiKey ? 'Ask a question...' : 'Set API key first'}
                disabled={!apiKey || loading}
                style={{
                  flex: 1, padding: '6px 10px', background: '#0e1117', color: '#e6edf3',
                  border: '1px solid #2a3040', borderRadius: 6, fontSize: 11,
                  fontFamily: 'inherit', outline: 'none',
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!apiKey || loading || !input.trim()}
                style={{
                  padding: '6px 12px', background: '#58a6ff', color: '#0e1117',
                  border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 11,
                  fontFamily: 'inherit', cursor: 'pointer',
                  opacity: !apiKey || loading || !input.trim() ? 0.4 : 1,
                }}
              >
                Ask
              </button>
            </div>
          </div>
        )
      })()}
    </>
  )
}
