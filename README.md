# ScreenLens — AI-Powered Learning & Screen Translation

A local learning app that captures your display, OCRs every word with pixel-precise positioning, translates foreign text via your choice of AI provider, and integrates with Anki for spaced repetition study. Supports multiple learning modes — from language learning to CompTIA certifications and beyond.

## Features

- **Screen capture** — `Ctrl+Shift+S` to screenshot any window/display
- **Paste / Upload / Drag-drop** — Alternative image input methods
- **Dual-pass OCR** — Runs Tesseract on both preprocessed and original images, merging results for maximum word detection on complex backgrounds (game art, textured UIs)
- **Pixel-accurate overlays** — Word bounding boxes from Tesseract OCR with hover translations, synonyms, pronunciation, and part of speech
- **Learning modes** — Create AI-configured modes for any subject (languages, Security+, Organic Chemistry, etc.)
- **Anki integration** — Generate AI-powered flashcards, sync to Anki and AnkiWeb, study with interleaved quizzes
- **Study sessions** — Multi-card interleaved quizzes with AI-generated questions, evaluation, grammar feedback, and Anki spaced repetition rating
- **Deck browser** — View, edit, search, and delete Anki flashcards directly in the app
- **Knowledge base** — Upload .txt/.md reference materials per mode for smarter AI questions
- **Grammar feedback** — Optional grammar/spelling correction in any quiz language
- **Overlay mode** — Fullscreen overlay on top of games/apps via Electron (optional)
- **Multi-provider AI** — Claude, GPT, Gemini, and Grok
- **18 languages** — Spanish, French, German, Japanese, Korean, Chinese, Russian, Arabic, etc.

## Architecture

```
screenlens/
  src/                 ← React web app
  electron/            ← Optional Electron overlay companion
    main.cjs           ← Electron main process
    preload.cjs        ← IPC bridge
  modes/
    Default/           ← Default mode template (committed to git)
    <your modes>/      ← Your custom modes (gitignored)
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

1. Select your AI provider from the dropdown (Anthropic, OpenAI, Gemini, or Grok)
2. Click **Key Set** and enter your API key
3. Select source and target languages (translation settings are separate from study quiz language)
4. Capture or upload a screenshot

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

1. Click **Study** in the toolbar
2. Select mode, deck, quiz language, and grammar feedback toggle
3. Click **Study Now** — AI generates questions from your Anki cards
4. Answer questions — AI evaluates each answer and rates the card
5. Ratings (Easy/Good/Hard/Again) sync back to Anki's spaced repetition system and AnkiWeb

Study features:
- **Interleaved questions** — multiple cards at once (default 3), questions shuffled randomly across cards to prevent answer leakage
- **Quiz language** — study in any language (questions and answers generated in that language)
- **Grammar feedback** — optional toggle for grammar/spelling correction (doesn't affect rating unless the grammar error is directly related to what the card tests)
- **Knowledge base context** — AI uses your uploaded reference materials for more targeted questions
- **Live Anki stats** — shows New/Learn/Due counts pulled live from Anki, updating after each card

### Deck browser

Click **Deck** in the toolbar to:
- View all flashcards in any deck
- Search cards by content
- Edit card fields inline (HTML converted to plain text for editing)
- Delete cards with confirmation
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
2. Click the **Overlay** button in the toolbar (or run `npm run overlay` in a separate terminal)
3. The Overlay button turns green when active
4. Switch to your game or app
5. Press **Ctrl+Shift+S** — screen is captured and the overlay appears fullscreen with the frozen screenshot
6. OCR + translation runs in the background — word boxes appear seamlessly on the frozen screenshot
7. Hover words for translations, click to pin, all features available
8. Press **ESC** to dismiss the overlay and return to your game
9. Press **Ctrl+Shift+S** again anytime for a new capture
10. Click the green Overlay button to stop Electron

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

A floating **?** button in the bottom-left corner provides an AI-powered help chat that knows the app inside and out.

- Click the **?** button to open the help chat
- Ask anything: "What does the overlay button do?", "How do I create flashcards?", "Can I use this with a game?"
- Follow-up questions supported — it's a full conversation
- Drag the button anywhere on screen to reposition it
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
  App.jsx              ← Main application component (~2800 lines)
  components/
    FormattedText.jsx   ← Rich text formatting for AI explanations
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
vite.config.js         ← Vite dev server + API endpoints (keys, config, modes, knowledge, anki proxy, overlay)
```
