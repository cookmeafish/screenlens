import { useState, useRef, useEffect } from 'react'

const HELP_CONTEXT = `You are the ScreenLens Help Assistant. You know everything about this app. Answer questions clearly and concisely.

# About ScreenLens
ScreenLens is an AI-powered learning and screen translation app. It captures screenshots, OCRs text with pixel-precise positioning, translates foreign text, and integrates with Anki for flashcard study.

# Key Features

## Screen Translation
- Ctrl+Shift+S captures any screen/window
- Paste, upload, or drag-drop images
- Dual-pass OCR (preprocessed + original image) for maximum word detection
- Hover any detected word to see translation, pronunciation, synonyms, and part of speech
- Click a word to pin it for detailed explanation
- Works with games, apps, websites — any screen content

## Learning Modes
- Click the mode button (e.g. "Language Learning") in the toolbar
- Type what you want to learn (e.g. "CompTIA Security+", "Spanish", "Organic Chemistry")
- AI generates a complete study configuration: card format, tags, study questions
- Each mode has its own settings, Anki deck, and knowledge base
- Click the gear icon to customize settings for the active mode
- Settings are per-mode — changing one doesn't affect others

## Anki Integration
- Requires Anki desktop app with AnkiConnect addon (code: 2055492159)
- Click a word → Generate Anki Card → AI creates rich flashcard
- Sync to Anki pushes cards to your selected deck and syncs to AnkiWeb (phone app)
- Deck browser: click "Deck" to view, edit, search, delete cards
- All Anki settings in gear icon → Anki Settings

## Study Sessions
- Click "Study" in the toolbar to start a quiz session
- Select mode, deck, quiz language, and grammar feedback toggle
- AI generates contextual questions from your Anki cards
- Multiple cards interleaved (default 3 at once) to prevent answer leakage
- AI evaluates answers and rates: Easy/Good/Hard/Again
- Ratings sync back to Anki's spaced repetition system
- Grammar feedback (optional toggle): corrects grammar without affecting rating unless relevant

## Knowledge Base
- Each mode has a knowledge/ folder for reference materials
- Gear icon → Knowledge Base → drag & drop .txt or .md files
- AI uses these files for smarter study questions and card generation
- Files can be enabled/disabled individually

## Overlay Mode (Optional)
- Requires Electron: npm install electron --save-optional
- Click "Overlay" in toolbar to start (turns green when active)
- Switch to your game/app, press Ctrl+Shift+S
- Screen freezes as a fullscreen overlay with word boxes on top
- Hover words for translations, all features work
- Press ESC to dismiss overlay and return to your game
- Overlay stays running — press Ctrl+Shift+S again anytime
- Click green Overlay button to stop Electron
- Works with borderless windowed games; fullscreen exclusive may not work

## Settings
- Click gear icon next to mode name
- Use dropdown to select which mode to configure
- Anki Settings: connection, deck, card format, tag rules, study rules
- Knowledge Base: upload reference materials
- All settings saved per-mode in modes/<name>/config.json

## Toolbar Buttons
- Mode button (e.g. "Language Learning"): switch/create modes
- Gear icon: open settings for current mode
- Study: start a quiz session from Anki cards
- Deck: browse/edit/delete Anki cards
- Key Set: configure AI provider API key
- Capture: screenshot via browser
- Upload: upload image file
- Overlay: start/stop Electron overlay for games
- Ctrl+Shift+S: keyboard shortcut for screen capture

## API Keys
- Supports Anthropic (Claude), OpenAI (GPT), Google (Gemini), xAI (Grok)
- Keys stored locally, never sent anywhere except the provider's API
- Click "Key Set" to enter your key
`

export default function HelpChat({ apiKey, providerConfig }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState({ x: 20, y: null }) // y=null means bottom
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const chatEndRef = useRef(null)
  const btnRef = useRef(null)

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Draggable button
  const handleMouseDown = (e) => {
    if (open) return
    setDragging(true)
    const rect = btnRef.current.getBoundingClientRect()
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }

  useEffect(() => {
    if (!dragging) return
    const handleMove = (e) => {
      setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    }
    const handleUp = () => setDragging(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => { window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', handleUp) }
  }, [dragging])

  const sendMessage = async () => {
    if (!input.trim() || loading || !apiKey) return
    const userMsg = input.trim()
    setInput('')
    const newMsgs = [...messages, { role: 'user', text: userMsg }]
    setMessages(newMsgs)
    setLoading(true)

    try {
      const history = newMsgs.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      }))
      const text = await providerConfig.call(apiKey, HELP_CONTEXT, history.map(m => `${m.role}: ${m.content}`).join('\n\n') + '\n\nuser: ' + userMsg)
      setMessages([...newMsgs, { role: 'assistant', text }])
    } catch (err) {
      setMessages([...newMsgs, { role: 'assistant', text: 'Sorry, I encountered an error: ' + err.message }])
    } finally {
      setLoading(false)
    }
  }

  const btnStyle = {
    position: 'fixed',
    left: pos.x,
    ...(pos.y !== null ? { top: pos.y } : { bottom: 20 }),
    width: 44, height: 44, borderRadius: '50%',
    background: open ? '#58a6ff' : '#1c2129',
    border: '2px solid #58a6ff',
    color: open ? '#0e1117' : '#58a6ff',
    fontSize: 18, fontWeight: 700,
    cursor: dragging ? 'grabbing' : 'grab',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10000, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    fontFamily: 'inherit',
    transition: 'background 0.15s, color 0.15s',
  }

  const chatStyle = {
    position: 'fixed',
    left: Math.min(pos.x, window.innerWidth - 380),
    ...(pos.y !== null ? { top: pos.y + 50 } : { bottom: 70 }),
    width: 360, maxHeight: 450,
    background: '#161b22', border: '1px solid #2a3040',
    borderRadius: 10, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    zIndex: 10000, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    fontFamily: "'JetBrains Mono', monospace",
  }

  return (
    <>
      <button
        ref={btnRef}
        onMouseDown={handleMouseDown}
        onClick={() => { if (!dragging) setOpen(!open) }}
        style={btnStyle}
        title="Help — ask anything about ScreenLens"
      >
        ?
      </button>

      {open && (
        <div style={chatStyle}>
          {/* Header */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #2a3040', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff' }}>ScreenLens Help</span>
            <span onClick={() => { setOpen(false); setMessages([]) }} style={{ cursor: 'pointer', color: '#7d8590', fontSize: 14 }}>&times;</span>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px', maxHeight: 320 }}>
            {messages.length === 0 && (
              <div style={{ color: '#484f58', fontSize: 11, textAlign: 'center', padding: '20px 0' }}>
                Ask anything about ScreenLens!<br />
                e.g. "What does the overlay button do?"
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                marginBottom: 8, padding: '6px 10px', borderRadius: 6,
                background: m.role === 'user' ? 'rgba(88,166,255,.1)' : 'rgba(125,133,144,.06)',
                fontSize: 12, color: '#c9d1d9', lineHeight: 1.5,
                textAlign: m.role === 'user' ? 'right' : 'left',
              }}>
                {m.text}
              </div>
            ))}
            {loading && (
              <div style={{ fontSize: 11, color: '#7d8590', padding: '4px 10px' }}>
                Thinking...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '8px 10px', borderTop: '1px solid #2a3040', display: 'flex', gap: 6 }}>
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
      )}
    </>
  )
}
