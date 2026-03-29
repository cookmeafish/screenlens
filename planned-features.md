# ScreenLens — Feature Status & Roadmap

## Implemented Features

### Core Translation (Phase 1-3) ✅
- Two-stage OCR + AI translation pipeline
- Dual-pass OCR (preprocessed + original image, merged results)
- Pixel-accurate word bounding boxes with hover translations
- Multi-provider AI support (Claude, GPT, Gemini, Grok)
- 18 language support
- Screen capture, paste, upload, drag-drop

### Learning Modes (Phase 4-7) ✅
- AI-generated mode creation ("What do you want to learn?")
- Per-mode settings: card format, tag rules, study rules, deck, knowledge base
- Mode-specific Anki deck selection
- AI-assisted format editing (natural language)
- Conditional UI (language selectors hidden for general modes)
- Default mode template committed to git
- Per-mode named folders in modes/ directory

### Anki Integration ✅
- AnkiConnect proxy via Vite dev server
- AI-powered flashcard generation with customizable templates
- AI-generated tags per mode's tag rules
- Deck browser (view, edit, search, delete cards)
- Auto-sync to AnkiWeb after card creation and study ratings
- Per-mode deck selection

### Study Sessions (Phase 8) ✅
- Interleaved multi-card quizzes (configurable cards at once)
- AI-generated contextual questions (not templates)
- AI answer evaluation with feedback
- Grammar feedback toggle (optional, per quiz language)
- Anki spaced repetition rating (Easy/Good/Hard/Again)
- Live New/Learn/Due counts from Anki
- Knowledge base context for smarter questions
- Quiz language selector (study in any language)
- Deleted card protection

### Knowledge Base ✅
- Per-mode knowledge/ folder
- Drag & drop file upload (.txt/.md)
- File list with enable/disable/delete
- AI uses enabled files as context during study and card generation

### Overlay Mode (Phase 9) ✅
- Electron companion app (optional, same repo)
- One-click launch/stop from toolbar with green/grey status indicator
- Ctrl+Shift+S screen capture via desktopCapturer
- Loads actual web app (localhost:3000?overlay=true) — no code duplication
- Fullscreen overlay covering entire screen including taskbar
- Seamless processing (no progress bar, screenshot stays fullscreen)
- ESC to dismiss (Electron stays running for next capture)
- All web app features available (hover, pin, explain, Anki)
- Process detection via tasklist, forceful kill via taskkill

## Future Improvements

### OCR Quality
- Consider Claude Vision API as alternative/supplement to Tesseract for complex game backgrounds
- Multi-resolution OCR passes for different text sizes
- Text region detection before OCR to focus on text areas

### Overlay Enhancements
- Click-through mode for transparent areas (per-pixel hit testing)
- Overlay settings accessible from overlay window
- Multiple monitor support
- Hotkey customization

### Study Improvements
- Spaced repetition scheduling within the app (without Anki)
- Study session history and statistics
- Progress tracking per mode

### General
- Export translations as CSV/JSON
- Translation history
- Keyboard navigation between words
- Side panel with full word list
- Multi-language auto-detection improvement
