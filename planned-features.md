# ScreenLens — Feature Status & Roadmap

## Implemented Features

### Core Translation (Phase 1-3) ✅
- Two-stage OCR + AI translation pipeline
- Dual-pass OCR (preprocessed + original image, merged results)
- Tight-fitting word bounding boxes with hover translations
- ESC to cancel ongoing OCR/translation
- Cancel button in progress bar
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
- Streaming start: first card shown immediately, rest generated in background
- Smart question ordering: blind recall → guided recall → deep explanation (scales to any questionsPerCard)
- Progressive hint system: wrong answer → letter count hint → first letter hint → Try Again
- Undo last answer (Back button) while card is unsynced
- Smart Wrap Up: drops unstarted cards immediately, only finishes in-progress ones
- Feedback chat trusts student corrections; mark_all_correct action for bulk typo fixes
- Deck browser edits sync back to active study session on close (no refresh needed)
- Browse cards save status feedback (Saving/Saved/error)

### Knowledge Base ✅
- Per-mode knowledge/ folder
- Drag & drop file upload (.txt/.md)
- File list with enable/disable/delete
- AI uses enabled files as context during study and card generation

### Overlay Mode (Phase 9) ✅
- Electron companion app (optional, same repo)
- One-click launch/stop from toolbar with green/grey status indicator
- Auto-detects running state on page load (immediate check + 3s polling)
- Ctrl+Shift+S screen capture via desktopCapturer
- Loads actual web app (localhost:3000?overlay=true) — no code duplication
- Fullscreen overlay covering entire screen including taskbar
- Floating progress indicator during OCR in overlay mode
- ESC to dismiss (Electron global shortcut, stays running for next capture)
- All web app features available (hover, pin, explain, Anki)
- Process detection via tasklist, forceful kill via taskkill

### AI Help Assistant ✅
- Draggable floating ? button (repositionable anywhere on screen)
- AI chat powered by Claude Sonnet for high-quality brief answers
- Comprehensive app knowledge embedded as system context
- Smart positioning: chat opens toward available screen space
- Auto-scroll to start of AI replies
- Input stays focused during and after AI responses
- Hidden in overlay mode

### Anki Card Formatting ✅
- Bold HTML labels (Pronunciación, Traducción, etc.)
- Proper line breaks between sections
- Rich formatting preserved in Anki desktop and mobile

## Future Improvements

### OCR Quality
- Consider Claude Vision API as alternative/supplement to Tesseract for complex game backgrounds
- Region selection (drag to select area to translate instead of full screen)
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
- Per-question immediate feedback mode (evaluate each answer as it's submitted rather than batch at card end)

### General
- Export translations as CSV/JSON
- Translation history
- Keyboard navigation between words
- Side panel with full word list
- Multi-language auto-detection improvement
