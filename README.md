# ScreenLens — AI-Powered Learning & Study Platform

A multi-tab learning app with AI chat, Anki-integrated study sessions, screen translation, and progress tracking. Supports multiple learning modes — from language learning to CompTIA certifications and beyond.

## Features

### Tabs
- **Chat** — AI conversational assistant for learning, with inline Anki card generation, deck attachment for personalized tutoring, web search, and persistent conversation history
- **Study** — Anki study sessions with AI-generated questions, deck browser, typo correction, feedback chat, "I know this" card deletion, wrap up/end now controls, and spaced repetition insights
- **Picture** — Screen capture/OCR/translation with pixel-accurate word overlays, overlay mode for games
- **Stats** — Study streaks, accuracy trends, per-deck breakdown (coming soon)

### Core Features
- **Multi-provider AI** — Claude, GPT, Gemini, and Grok with unified provider settings panel
- **Learning modes** — Create AI-configured modes for any subject (languages, Security+, Organic Chemistry, etc.)
- **Anki integration** — Generate flashcards, sync to Anki, study with AI quizzes, browse/edit decks
- **Knowledge base** — Upload .txt/.md reference materials per mode for smarter AI context
- **Progress tracking** — Per-deck progress observations saved to disk, AI tracks struggles and improvements across sessions
- **18 languages** — Spanish, French, German, Japanese, Korean, Chinese, Russian, Arabic, etc.

### Chat Tab
- Full AI chatbot for explaining concepts and answering questions
- Ask the AI to create Anki flashcards inline — cards appear with preview, edit, and sync controls
- Attach an Anki deck for personalized tutoring — AI reads all cards + progress observations to focus on weak areas
- **Web search** — toggle the globe button to search the internet before AI responds, with clickable source citations and live status indicators (searching, found results, analyzing, etc.)
- Conversation history persisted to disk (`chats/` directory) with session management sidebar
- AI can auto-update progress observations when it discovers new struggles or improvements

### Study Tab
- **Instant start** — first card appears immediately (one AI call), remaining cards generate in the background while you answer
- **Smart question ordering** — Q1 is always blind recall (never names the target word), middle questions use guided recall/synonym contrast, last question is deep understanding (can name the subject). Scales to any questions-per-card setting
- **Hint system** — wrong answer on a recall question shows a letter-count hint ("9 letters"); wrong again shows a first-letter hint ("starts with 'i'"). Button changes to "Try Again". Applies to any question type with multiple possible answers
- **Back button** — undo your last answer and retry the question, as long as that card hasn't been synced to Anki yet
- **10-card continuous system** — 10 cards active at once, questions randomly interleaved. When a card completes, a new one is pulled from the pool automatically
- **Card front hidden** — questions don't reveal which card they belong to, preventing answer leakage
- **Zero-delay answers** — answers recorded instantly with no AI call. Next question appears immediately
- **Batch evaluation** — AI evaluates all answers for a card at once in the background, only after the last question is answered
- **Inline feedback** — completed card feedback appears below the active question as evaluations finish, so you can review while continuing to answer other cards
- **Previous attempts shown** — results view shows all retry attempts grayed out above the final answer
- **Smart evaluation** — for language learning, typos in the response language (e.g. English typos when studying Spanish) don't count against you
- **Feedback chat** — after feedback is revealed, chat with AI to fix typos, flag out-of-scope questions, or request card updates. AI trusts student corrections and never argues
- **Card updates from feedback** — AI can update Anki card content to add clarity
- **Ratings synced after review** — Anki ratings only sync when you finish, giving you time to dispute/correct first
- **"I know this already"** — delete cards you've mastered with AI confirmation
- **Smart Wrap Up** — immediately drops all unstarted cards (0 answers), finishes only in-progress ones. Session ends as fast as possible without abandoning cards you already started
- **End Now** — immediately end session with partial results
- **Spaced repetition insights** — AI analyzes session results and updates `decks/<deck>/progress-observations.md` with struggles, improvements, and mastered topics
- **Multiple choice support** — AI can generate multiple choice questions when it makes sense, but prefers text-based answers

### Picture Tab
- **Screen capture** — `Ctrl+Shift+S` for full screen, `Ctrl+Shift+A` for area selection
- **Area selection** — transparent drawing window, screen not frozen during selection, only selected area captured
- **Paste / Upload / Drag-drop** — Alternative image input methods
- **Dual-pass OCR** — Tesseract on preprocessed + original images for maximum detection
- **Pixel-accurate overlays** — Hover any word for translation, pronunciation, synonyms, part of speech
- **Anki card generation** — Click a word, generate a card, edit/refine with AI, sync to Anki
- **Draggable tooltip** — Pinned word tooltip can be dragged anywhere, position saved across sessions
- **Overlay mode** — Fullscreen overlay on top of games/apps via Electron

## Architecture

```
screenlens/
  src/                 ← React web app (single App.jsx with tab routing)
  electron/            ← Optional Electron overlay companion
    main.cjs           ← Electron main process (overlay + area select)
    preload.cjs        ← IPC bridge
  modes/
    Default/           ← Default mode template (committed to git)
    <your modes>/      ← Your custom modes (gitignored)
  chats/               ← Persistent chat sessions (gitignored)
  decks/               ← Per-deck progress tracking (auto-created)
    <deck-name>/
      progress-observations.md  ← AI-maintained struggle/improvement log
  vite.config.js       ← Dev server + API endpoints
```

**Dual-pass OCR pipeline:**
1. **Tesseract.js Pass 1** — High-contrast preprocessed image (grayscale, 2.5x contrast, dark-bg inversion). Good for clean text.
2. **Tesseract.js Pass 2** — Original image. Catches text on complex/textured backgrounds that preprocessing destroys.
3. **Merge** — Non-overlapping words from pass 2 are added to pass 1 results.
4. **AI Translation** — Merged word list sent to AI for translation, synonyms, pronunciation, and part of speech.

## Setup

```bash
git clone https://github.com/cookmeafish/screenlens.git
cd screenlens
npm install
npm run dev
```

Opens at `http://localhost:3000`.

## Configuration

1. Click the **AI provider button** in the toolbar (e.g. "Anthropic (Claude)")
2. Select your provider and enter your API key in the settings panel
3. Click the **gear icon** to configure language settings, Anki, and knowledge base
4. Navigate between tabs: **Chat** for AI conversation, **Study** for Anki quizzes, **Picture** for screen translation

## Supported AI Providers

| Provider | Model | JSON Mode |
|---|---|---|
| **Anthropic (Claude)** | Claude Haiku 4.5 | Prompt-based |
| **OpenAI (GPT)** | GPT-4o-mini | `response_format: json_object` |
| **Google (Gemini)** | Gemini 2.0 Flash | `responseMimeType: application/json` |
| **xAI (Grok)** | Grok 3 Mini Fast | Prompt-based |

## Learning Modes

ScreenLens supports multiple learning modes. Each mode has its own:
- Anki card format (front/back templates, fields)
- Tag generation rules
- Study rules (question prompt, quiz language, grammar feedback, cards at once)
- Connected Anki deck
- Knowledge base (reference materials)

All settings are **per-mode** — changing Security+ settings doesn't affect Language Learning.

### Creating a mode

1. Click the mode button in the toolbar (e.g., "Language Learning")
2. Type what you want to learn (e.g., "CompTIA Security+", "Organic Chemistry")
3. Click **Create** — AI generates the full mode configuration (card format, tags, study questions)
4. Click the **gear icon** to customize any settings
5. Or click **+ Default Mode** to create a new Language Learning mode with defaults

### Mode settings

Click the **gear icon** next to the mode name. Use the dropdown to select which mode to configure:

- **Anki Settings** — connection status, deck selection, card format, tag rules, study rules
  - **Card Format** — AI edit input, field toggles, front/back templates with placeholders
  - **Tag Rules** — instructions for AI tag generation per card
  - **Study Rules** — questions per card, cards at once, quiz language, grammar feedback toggle, AI question generation prompt
- **Knowledge Base** — drag & drop .txt/.md files, enable/disable/delete individual files

Mode configurations are saved in `modes/<mode-name>/config.json`.

### Mode storage

```
modes/
  Default/              ← Default template (committed to git)
    config.json
  Language Learning/    ← Your modes (gitignored)
    config.json
    knowledge/          ← Reference materials (optional)
      vocab.txt
  Security+/
    config.json
    knowledge/
      chapter1.md
```

## Anki Integration

### Setup

1. Install [Anki](https://apps.ankiweb.net/) desktop app
2. Open Anki → **Tools → Add-ons → Get Add-ons...**
3. Paste the addon code: **`2055492159`** ([AnkiConnect](https://ankiweb.net/shared/info/2055492159))
4. Click **OK** and restart Anki

### Flashcard generation

1. Click a translated word to pin it
2. Click **Explain** for a brief explanation
3. Click **Generate Anki Card** — AI creates a rich flashcard with pronunciation, definition, synonyms, and example sentence
4. Select target deck from dropdown in card preview
5. Click **Sync to Anki** — pushes to Anki and syncs to AnkiWeb automatically

Card format is AI-generated per mode and fully customizable via the Card Format settings.

### Study sessions

1. Go to the **Study** tab and click **Study Now**
2. Select mode, deck, quiz language — the first card appears immediately, rest generate in background
3. Answer questions — Q1 is always blind recall (no target word in question). Wrong answers trigger progressive hints
4. Use **← Back** to undo your last answer and retry (available until the card syncs to Anki)
5. As each card completes, AI evaluates in the background and feedback appears inline
6. Review feedback while continuing to answer other cards. Use the feedback chat to fix typos, dispute answers, or clarify cards
7. New cards are pulled automatically as you complete them, keeping 10 active
8. When done, click **View Summary** → **Generate Insights** for AI analysis + progress tracking
9. Ratings sync to Anki only when you finish, after you've had a chance to review and correct

Study features:
- **Instant start** — only one AI call before the first question appears; rest load in background
- **Ordered questions** — blind recall first, deep explanation last, guided recall in between
- **Progressive hints** — letter count hint, then first-letter hint, then "Try Again"
- **Back / undo** — undo last answer on any unsynced card
- **10-card pool** — questions randomly interleaved across 10 active cards for natural spacing
- **Hidden card fronts** — prevents answer leakage
- **Smart language evaluation** — English typos don't penalize you when studying Spanish
- **Feedback chat** — dispute answers, fix typos, flag out-of-scope questions, update Anki cards
- **Smart Wrap Up** — drops unstarted cards immediately, finishes only what you've started
- **End Now** — immediate session end with partial results
- **"I know this"** — delete mastered cards with confirmation
- **Progress observations** — AI maintains `decks/<deck>/progress-observations.md` tracking struggles, improvements, and mastery
- **Knowledge base context** — AI uses your uploaded reference materials for targeted questions
- **Multiple choice** — AI can generate multiple choice when appropriate, prefers text answers

### Deck browser

Go to the **Study** tab and click **Browse Deck** to:
- View all flashcards in any deck
- Search cards by content
- Edit card fields inline with AI refine input ("Say football instead of soccer")
- Delete cards with confirmation
- Save button shows live status (Saving → Saved / Save failed — is Anki open?)
- Closing the browser syncs any edits back into your active study session immediately — no tab refresh needed
- Changes auto-sync to AnkiWeb

## Knowledge Base

Each mode can have reference materials that the AI uses for context during study sessions and card generation.

1. Click the gear icon → expand **Knowledge Base**
2. Drag & drop `.txt` or `.md` files into the drop zone, or click to browse
3. Files are listed with size, enable/disable toggle, and delete button
4. Enabled files are loaded automatically when starting a study session

Files are stored in `modes/<mode-name>/knowledge/` and can be managed entirely from the settings UI.

## Overlay Mode (Optional)

A fullscreen overlay that sits on top of games and apps for seamless screen translation. The overlay loads the same web app — all features (hover, pin, explain, Anki) work identically.

### Setup

```bash
# Install Electron (one-time, optional)
npm install electron --save-optional
```

### Usage

1. Start the web app: `npm run dev`
2. Go to the **Picture** tab and click **Overlay** (or run `npm run overlay`)
3. Switch to your game or app
4. **Ctrl+Shift+S** — full screen capture, overlay appears with frozen screenshot
5. **Ctrl+Shift+A** — area selection: transparent drawing window appears, draw a rectangle, only that area is captured and frozen while the rest of the desktop stays interactive
6. Hover words for translations, click to pin, all features available
7. Press **ESC** to dismiss the overlay
8. Click the green Overlay button to stop Electron

### How it works

- Electron captures a screenshot via `desktopCapturer` and saves it as a PNG
- The overlay window loads `localhost:3000?overlay=true` — the same web app with the header hidden
- The web app auto-loads the screenshot and runs the full OCR/translation pipeline
- The overlay covers the entire screen (including taskbar area) for a seamless frozen-screen illusion
- ESC hides the overlay but Electron stays running for the next capture

### Notes

- The overlay shares the same Vite dev server — API keys, modes, Anki connection are all shared
- The web app works independently in the browser — the overlay is purely optional
- Fullscreen exclusive games may not work; use borderless windowed mode
- The Overlay button toggles on/off and auto-detects if Electron is running

## AI Help Assistant

A floating **?** button provides a context-aware AI assistant that knows the app and your current state.

- Click the **?** button to open the help chat, drag it anywhere on screen
- **Context-aware** — sees your current tab, active mode, OCR words, selected word details, study session, and recent chat messages
- **Dock to side panel** — click the dock icon to pin the help chat as a right-side panel; pop out to return to floating mode
- **Persistent history** — help chat sessions are saved to disk and appear in the Chat tab sidebar (marked with a blue ?)
- **New chat** — click + to start a fresh help conversation; old ones remain accessible in the Chat tab
- Ask anything: "What does this word mean?", "Help me with this study question", "How do I use the overlay?"
- Uses your configured AI provider and API key
- Hidden in overlay mode to avoid interfering with gameplay

## Requirements

- Node.js 18+
- API key for at least one supported provider
- Chrome/Edge/Brave recommended (Firefox works but screen capture may be limited)
- Anki + AnkiConnect addon (for flashcard and study features)
- Electron (optional, for overlay mode only)

## Project Structure

```
src/
  App.jsx              ← Main application component
  components/
    FormattedText.jsx   ← Rich text formatting for AI explanations
    HelpChat.jsx        ← Context-aware floating/docked help assistant
  config/
    languages.js       ← 18 supported languages
    prompts.js         ← Translation prompt + POS/category color maps
    providers.js       ← AI provider implementations (Anthropic, OpenAI, Gemini, Grok)
  styles/
    theme.js           ← GitHub Dark design system (~100 style objects)
  utils/
    anki.js            ← AnkiConnect API wrapper (ping, decks, cards, notes, sync)
    logger.js          ← OCR pipeline logging
electron/
  main.cjs             ← Electron main process (window, shortcuts, screenshot capture)
  preload.cjs          ← IPC bridge (contextBridge)
modes/
  Default/             ← Default Language Learning config template (committed)
    config.json
  <user modes>/        ← Custom modes with per-mode configs + knowledge (gitignored)
vite.config.js         ← Vite dev server + API endpoints (keys, config, modes, knowledge, anki proxy, overlay, chats, web search)
```
