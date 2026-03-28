# ScreenLens — AI-Powered Learning & Screen Translation

A local learning app that captures your display, OCRs every word with pixel-precise positioning, translates foreign text via your choice of AI provider, and integrates with Anki for spaced repetition study. Supports multiple learning modes — from language learning to CompTIA certifications and beyond.

## Features

- **Screen capture** — `Ctrl+Shift+S` to screenshot any window/display
- **Paste / Upload / Drag-drop** — Alternative image input methods
- **Pixel-accurate overlays** — Word bounding boxes from Tesseract OCR, not AI estimates
- **Hover translations** — Hover any word on the image for translation + synonyms + pronunciation
- **Learning modes** — Create AI-configured modes for any subject (languages, Security+, etc.)
- **Anki integration** — Generate flashcards, sync to Anki, study with AI-powered quizzes
- **Study sessions** — Interleaved multi-card quizzes with AI evaluation and Anki rating sync
- **Knowledge base** — Upload reference materials per mode for smarter AI questions
- **Grammar feedback** — Optional grammar/spelling correction in any language
- **Overlay mode** — Transparent overlay on top of games/apps via Electron (optional)
- **Multi-provider AI** — Claude, GPT, Gemini, and Grok
- **18 languages** — Spanish, French, German, Japanese, Korean, Chinese, Russian, Arabic, etc.

## Architecture

```
screenlens/
  src/                 ← React web app
  electron/            ← Optional Electron overlay companion
  modes/
    Default/           ← Default mode template (committed)
    <your modes>/      ← Your custom modes (gitignored)
  vite.config.js       ← Dev server + API endpoints
```

**Two-stage pipeline:**
1. **Tesseract.js** — OCR engine returning pixel-accurate bounding boxes. Runs in-browser via WebAssembly.
2. **AI Translation** — Receives extracted words, returns translations, synonyms, pronunciation, and part of speech.

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
3. Select source and target languages
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
- Study rules (question style, quiz language, grammar feedback)
- Connected Anki deck
- Knowledge base (reference materials)

### Creating a mode

1. Click the mode button in the toolbar (e.g., "Language Learning")
2. Type what you want to learn (e.g., "CompTIA Security+", "Organic Chemistry")
3. Click **Create** — AI generates the full mode configuration
4. Click the gear icon to customize any settings

### Mode settings

Click the **gear icon** next to the mode name:
- **Anki Settings** — connection, deck, card format, tag rules, study rules
- **Knowledge Base** — upload .txt/.md reference materials for smarter AI questions

All settings are per-mode and saved in `modes/<mode-name>/config.json`.

## Anki Integration

### Setup

1. Install [Anki](https://apps.ankiweb.net/) desktop app
2. Open Anki → **Tools → Add-ons → Get Add-ons...**
3. Paste the addon code: **`2055492159`** ([AnkiConnect](https://ankiweb.net/shared/info/2055492159))
4. Click **OK** and restart Anki

### Flashcard generation

1. Click a translated word to pin it
2. Click **Generate Anki Card** — AI creates a rich flashcard with pronunciation, definition, synonyms, and example sentence
3. Click **Sync to Anki** — pushes to your selected deck and syncs to AnkiWeb

### Study sessions

1. Click **Study** in the toolbar
2. Select mode, deck, quiz language, and grammar feedback toggle
3. Click **Study Now** — AI generates questions from your Anki cards
4. Answer questions — AI evaluates and rates each card (Easy/Good/Hard/Again)
5. Ratings sync back to Anki's spaced repetition system

Study features:
- **Interleaved questions** — multiple cards at once, questions shuffled to prevent answer leakage
- **Quiz language** — study in any language (questions and answers in that language)
- **Grammar feedback** — optional toggle for grammar/spelling correction
- **Knowledge base context** — AI uses your uploaded reference materials for smarter questions

### Deck browser

Click **Deck** in the toolbar to view, edit, search, and delete flashcards directly in the app.

## Knowledge Base

Each mode can have reference materials that the AI uses for context during study sessions.

1. Click the gear icon → expand **Knowledge Base**
2. Drag & drop `.txt` or `.md` files, or click to browse
3. Files are loaded automatically when starting a study session

Files are stored in `modes/<mode-name>/knowledge/` and can be enabled/disabled individually.

## Overlay Mode (Optional)

A transparent overlay that sits on top of games and apps for real-time screen translation. Powered by Electron.

### Setup

```bash
# Install Electron (one-time, optional)
npm install electron --save-optional
```

### Usage

**Option A — One-click from the web app:**
1. Start the web app: `npm run dev`
2. Click the **Overlay** button in the toolbar

**Option B — Manual launch:**
1. Start the web app: `npm run dev`
2. In a separate terminal: `npm run overlay`

**Using the overlay:**
1. Switch to your game or app (borderless windowed mode recommended)
2. Press **Ctrl+Shift+S** — screen is captured and translated words appear as a transparent overlay
3. Hover words to see translations
4. Press **ESC** to dismiss the overlay

The overlay connects to the same Vite dev server, sharing your API keys, modes, and Anki connection. The web app works independently — the overlay is purely optional.

**Note:** Fullscreen exclusive games may not work. Use borderless windowed mode.

## Requirements

- Node.js 18+
- API key for at least one supported provider
- Chrome/Edge/Brave recommended (Firefox works but screen capture may be limited)
- Anki + AnkiConnect addon (for flashcard features)
- Electron (optional, for overlay mode only)

## Project Structure

```
src/
  App.jsx              ← Main application component
  components/          ← UI components
  config/
    languages.js       ← Supported languages
    prompts.js         ← Translation prompt + POS colors
    providers.js       ← AI provider implementations
  styles/
    theme.js           ← Design system
  utils/
    anki.js            ← AnkiConnect API wrapper
    logger.js          ← OCR pipeline logging
electron/
  main.js              ← Electron main process
  preload.js           ← IPC bridge
  overlay.html         ← Overlay page
  overlay.js           ← Overlay OCR + rendering
modes/
  Default/             ← Default Language Learning config (committed)
  <user modes>/        ← Custom modes (gitignored)
```
