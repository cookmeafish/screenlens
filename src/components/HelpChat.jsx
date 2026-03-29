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
  const lastMsgCount = useRef(0)

  // Scroll to top of latest assistant reply
  useEffect(() => {
    if (messages.length > lastMsgCount.current && messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant' && msgTopRef.current) {
        msgTopRef.current.scrollTop = msgTopRef.current.scrollHeight
        // Find the last assistant message element and scroll it into view at the top
        setTimeout(() => {
          const els = msgTopRef.current?.querySelectorAll('[data-msg]')
          if (els && els.length > 0) {
            els[els.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }, 50)
      }
    }
    lastMsgCount.current = messages.length
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
    }
  }

  // Smart positioning: chat opens toward screen center from button position
  const getBtnPos = () => {
    const bx = pos.x
    const by = pos.y !== null ? pos.y : window.innerHeight - 64
    return { bx, by }
  }

  const getChatPos = () => {
    const { bx, by } = getBtnPos()
    const chatW = 340, chatH = 400
    // Horizontal: open right if button is on left half, left if on right
    const openRight = bx < window.innerWidth / 2
    const left = openRight ? bx : bx - chatW + 44
    // Vertical: open up if button is on bottom half, down if on top
    const openUp = by > window.innerHeight / 2
    const top = openUp ? by - chatH - 10 : by + 54
    return { left: Math.max(5, Math.min(left, window.innerWidth - chatW - 5)), top: Math.max(5, Math.min(top, window.innerHeight - chatH - 5)) }
  }

  const btnPos = getBtnPos()

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
        const chatPos = getChatPos()
        return (
          <div style={{
            position: 'fixed', left: chatPos.left, top: chatPos.top,
            width: 340, maxHeight: 400,
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
