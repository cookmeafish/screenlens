# ScreenLens — Screen Translator

A local screen translation tool that captures your display, OCRs every word with pixel-precise positioning, translates foreign text via your choice of AI provider, and overlays hoverable translations directly on the screenshot.

## Architecture

**Two-stage pipeline — each tool does what it's good at:**

1. **Tesseract.js** — Real OCR engine. Returns pixel-accurate bounding boxes (x0, y0, x1, y1) for every detected word. Runs entirely in-browser via WebAssembly.
2. **AI Translation** — Receives the extracted word list only. Returns English translations and synonyms. Never touches positioning. Supports multiple providers.

## Supported AI Providers

| Provider | Model | JSON Mode |
|---|---|---|
| **Anthropic (Claude)** | Claude Sonnet 4 | Prompt-based |
| **OpenAI (GPT)** | GPT-4o-mini | `response_format: json_object` |
| **Google (Gemini)** | Gemini 2.0 Flash | `responseMimeType: application/json` |
| **xAI (Grok)** | Grok 3 Mini Fast | Prompt-based |

Switch providers from the dropdown in the header. API keys are stored per-provider in localStorage.

## Features

- **Screen capture** — `Ctrl+Shift+S` to screenshot any window/display via `getDisplayMedia`
- **Paste / Upload / Drag-drop** — Alternative image input methods
- **Pixel-accurate overlays** — Word bounding boxes from Tesseract, not AI estimates
- **Hover translations** — Hover any word on the image for English translation + synonyms
- **Fullscreen expand** — Click the image to zoom in, ESC to close
- **16 languages** — Spanish, French, German, Japanese, Korean, Chinese, Russian, Arabic, etc.
- **Highlight toggle** — Show/hide foreign word highlights
- **Multi-provider support** — Switch between Claude, GPT, Gemini, and Grok
- **Smart error handling** — Credit/quota errors show direct billing links and one-click provider switching
- **API key management** — Stored per-provider in localStorage, with direct links to get keys

## Setup

```bash
# Clone or extract the project
cd screenlens

# Install dependencies
npm install

# Start dev server
npm run dev
```

Opens at `http://localhost:3000`.

## Configuration

1. Select your AI provider from the dropdown in the header
2. Click **🔑 Set Key** and enter your API key
3. Click **Get key** if you need to create one — links directly to the provider's key page
4. Select the source language from the language dropdown (defaults to Spanish)
5. Capture or upload a screenshot

## API Keys

The app calls AI provider APIs directly from the browser. Your keys are stored in `localStorage` and never sent anywhere except the respective provider's API endpoint:

- `api.anthropic.com` (Anthropic)
- `api.openai.com` (OpenAI)
- `generativelanguage.googleapis.com` (Google)
- `api.x.ai` (xAI)

For production use, you'd want to proxy through a backend. For personal local use, direct browser access is fine.

## Requirements

- Node.js 18+
- API key for at least one supported provider
- Chrome/Edge/Brave recommended (Firefox works but screen capture may be limited)

## Usage with Claude Code

This project is designed to be iterated on with Claude Code. Some ideas:

- Add zoom/pan in the expanded view
- Save translation history
- Add a side panel with full word list
- Support multi-language detection (auto-detect)
- Add keyboard navigation between words
- Export translations as CSV/JSON
- Add a mini-dictionary view for repeated words
