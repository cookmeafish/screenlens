# Planned Features: Learning Modes System

## Overview
Transform ScreenLens from a language-specific translator into a general-purpose learning app with AI-driven mode configuration. Full implementation plan with phases.

---

## Phase 1: Mode Data Model & Migration

### Goal
Replace the "profile" concept with "modes" that include type, description, and tag rules. Migrate existing data.

### Changes

**`src/App.jsx` — State variables (lines ~126-146)**

Replace:
```js
const defaultProfile = {
  id: 1, name: 'Profile 1',
  fields: { pronunciation: true, translation: true, synonyms: true, definition: true, example: true },
  frontTemplate: '{word} ({partOfSpeech})',
  backTemplate: 'Pronunciación: {pronunciation}\n...',
}
const [ankiProfiles, setAnkiProfiles] = useState([defaultProfile])
const [ankiActiveProfileId, setAnkiActiveProfileId] = useState(1)
const [showAnkiFormatEditor, setShowAnkiFormatEditor] = useState(false)
const [editingProfileName, setEditingProfileName] = useState(null)
const ankiFormat = ankiProfiles.find(...)
```

With:
```js
const defaultMode = {
  id: 1,
  name: 'Language Learning',
  type: 'language',           // 'language' | 'general'
  description: '',            // user's original input that created this mode
  fields: { pronunciation: true, translation: true, synonyms: true, definition: true, example: true },
  frontTemplate: '{word} ({partOfSpeech})',
  backTemplate: 'Pronunciación: {pronunciation}\nTraducción: {translation}\nSinónimos: {synonyms}\nDefinición: {definition}\nEjemplo: {example}',
  tagRules: 'Always include:\n- part of speech (e.g. verb, noun, adjective)\n- source language (e.g. spanish, french)\n- "screenlens"\n\nAlso include when relevant:\n- verb tense (e.g. present, past, subjunctive)\n- difficulty (e.g. common, intermediate, advanced)\n- topic (e.g. food, emotion, travel, nature)',
}
const [modes, setModes] = useState([defaultMode])
const [activeModeId, setActiveModeId] = useState(1)
const [showModePanel, setShowModePanel] = useState(false)
const [showModeFormatEditor, setShowModeFormatEditor] = useState(false)
const [editingModeName, setEditingModeName] = useState(null)
const [modeCreating, setModeCreating] = useState(false)
const [modeEditInput, setModeEditInput] = useState('')

const activeMode = modes.find((m) => m.id === activeModeId) || modes[0] || defaultMode
// ankiFormat alias for backwards compatibility in card generation
const ankiFormat = activeMode
```

**`src/App.jsx` — Mount loader (lines ~150-170)**

Update the `ankiformat.json` loader to handle migration:
```js
if (format) {
  if (format.modes) {
    // New format
    setModes(format.modes)
    if (format.activeModeId) setActiveModeId(format.activeModeId)
  } else if (format.profiles) {
    // Migrate profiles → modes
    const migrated = format.profiles.map((p) => ({
      ...p,
      type: 'language',
      description: '',
      tagRules: defaultMode.tagRules,
    }))
    setModes(migrated)
    if (format.activeProfileId) setActiveModeId(format.activeProfileId)
  } else if (format.fields) {
    // Migrate single format → mode
    setModes([{ ...defaultMode, ...format, id: 1, name: 'Language Learning', type: 'language' }])
  }
}
```

**`src/App.jsx` — Management functions (lines ~892-940)**

Rename all profile functions to mode equivalents:
- `saveAnkiProfiles` → `saveModes(modes, activeId)`
- `updateActiveProfile` → `updateActiveMode(updates)`
- `addProfile` → (removed, replaced by AI mode creation in Phase 2)
- `deleteProfile` → `deleteMode(id)`
- `renameProfile` → `renameMode(id, newName)`

Payload key changes: `{ profiles, activeProfileId }` → `{ modes, activeModeId }`

### Verification
- App loads with existing ankiformat.json → migrates profiles to modes
- Existing card generation still works
- Mode management (rename, delete, switch) works

---

## Phase 2: AI Mode Creation

### Goal
Add the "What do you want to learn?" input that creates new modes via AI.

### Changes

**`src/App.jsx` — New function: `createMode(description)`**

```js
const createMode = async (description) => {
  if (!apiKey || modeCreating) return
  setModeCreating(true)
  try {
    const prompt = `The user wants to create a study mode for: "${description}"

Generate a JSON config for this study mode:
- "name": short name (2-3 words max, e.g. "Security+", "Spanish", "Organic Chemistry")
- "type": "language" if this is about learning a foreign language, "general" otherwise
- "fields": object with field names as keys and true as values. These become the JSON keys the AI will fill when generating flashcards. For language modes use: { "pronunciation": true, "translation": true, "synonyms": true, "definition": true, "example": true }. For general modes, choose 3-5 fields appropriate to the subject (e.g. { "definition": true, "example": true, "category": true, "keyPoints": true }).
- "frontTemplate": card front using {fieldName} placeholders. For language: "{word} ({partOfSpeech})". For general: "{term}" or similar.
- "backTemplate": card back using {fieldName} placeholders and \\n for newlines. Use descriptive labels before each placeholder.
- "tagRules": instructions for AI tag generation. Include "screenlens" always. Add subject-specific categories. Tags should be lowercase, no spaces (use hyphens).

Output ONLY raw JSON. No markdown, no backticks.`

    const text = await providerConfig.call(apiKey,
      'You configure study modes for a learning app. Always respond with valid JSON only.',
      prompt
    )
    const config = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))

    const newId = Math.max(0, ...modes.map((m) => m.id)) + 1
    const newMode = {
      id: newId,
      name: config.name || description.slice(0, 20),
      type: config.type || 'general',
      description,
      fields: config.fields || { definition: true, example: true },
      frontTemplate: config.frontTemplate || '{term}',
      backTemplate: config.backTemplate || 'Definition: {definition}',
      tagRules: config.tagRules || 'Include: screenlens',
    }

    const updated = [...modes, newMode]
    saveModes(updated, newId)
    console.log('[Mode] created:', newMode)
  } catch (err) {
    console.error('[Mode] creation failed:', err.message)
    setAnkiError('Mode creation failed: ' + err.message)
  } finally {
    setModeCreating(false)
  }
}
```

**`src/App.jsx` — Mode panel UI (replaces profile selector in format editor)**

In the Anki settings area, add a mode panel that opens when clicking the mode button in the toolbar:

```jsx
{showModePanel && (
  <div style={{ ...S.keyBar, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff' }}>Learning Modes</div>

    {/* Mode list */}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {modes.map((m) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {editingModeName === m.id ? (
            <input autoFocus defaultValue={m.name}
              onBlur={(e) => renameMode(m.id, e.target.value || m.name)}
              onKeyDown={(e) => { if (e.key === 'Enter') renameMode(m.id, e.target.value || m.name) }}
              style={{ ...S.keyInput, width: 120, fontSize: 11, padding: '4px 8px' }}
            />
          ) : (
            <button
              onClick={() => { setActiveModeId(m.id); saveModes(modes, m.id) }}
              onDoubleClick={() => setEditingModeName(m.id)}
              title={`${m.type === 'language' ? '🌐' : '📚'} ${m.description || m.name}\nDouble-click to rename`}
              style={{
                padding: '4px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                background: m.id === activeModeId ? 'rgba(88,166,255,.2)' : 'rgba(125,133,144,.1)',
                color: m.id === activeModeId ? '#58a6ff' : '#7d8590',
                border: m.id === activeModeId ? '1px solid rgba(88,166,255,.4)' : '1px solid #2a3040',
                fontWeight: m.id === activeModeId ? 700 : 400,
              }}
            >
              {m.type === 'language' ? '🌐' : '📚'} {m.name}
            </button>
          )}
          {modes.length > 1 && (
            <span onClick={() => deleteMode(m.id)} style={{ cursor: 'pointer', color: '#7d8590', fontSize: 12 }}>&times;</span>
          )}
        </div>
      ))}
    </div>

    {/* Create new mode */}
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={modeEditInput}
        onChange={(e) => setModeEditInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && modeEditInput.trim()) { createMode(modeEditInput.trim()); setModeEditInput('') } }}
        placeholder="What do you want to learn? (e.g. Spanish, Security+, Organic Chemistry)"
        style={{ ...S.keyInput, flex: 1 }}
        disabled={modeCreating}
      />
      <button
        onClick={() => { if (modeEditInput.trim()) { createMode(modeEditInput.trim()); setModeEditInput('') } }}
        disabled={modeCreating || !modeEditInput.trim()}
        style={{ ...S.keyDone, opacity: modeCreating || !modeEditInput.trim() ? 0.5 : 1 }}
      >
        {modeCreating ? 'Creating...' : 'Create Mode'}
      </button>
    </div>

    {/* Format editor toggle */}
    <div style={{ display: 'flex', gap: 8 }}>
      <button onClick={() => setShowModeFormatEditor(!showModeFormatEditor)}
        style={{ ...S.getKeyLink, background: 'rgba(210,168,255,.12)', color: '#d2a8ff', borderColor: 'rgba(210,168,255,.25)' }}>
        Edit Card Format
      </button>
      <button onClick={() => setShowModePanel(false)} style={S.keyDone}>Done</button>
    </div>
  </div>
)}
```

**`src/App.jsx` — Toolbar mode button (in headerRight, ~line 1278)**

Replace the "Anki: deckname" button with a mode indicator:
```jsx
<button onClick={() => setShowModePanel(!showModePanel)} style={{
  ...S.ghostBtn,
  color: '#58a6ff',
  borderColor: 'rgba(88,166,255,0.25)',
}}>
  {activeMode.type === 'language' ? '🌐' : '📚'} {activeMode.name}
</button>
```

Keep the existing Anki connection button separate (deck selection, connection status).

### Verification
- Click mode button → mode panel opens with mode list and text input
- Type "CompTIA Security+" → AI creates a general mode with appropriate format
- Type "Japanese" → AI creates a language mode
- Switch between modes → active mode changes
- Double-click mode name → inline rename

---

## Phase 3: AI-Generated Tags

### Goal
Replace hardcoded tags with AI-generated tags using the mode's `tagRules`.

### Changes

**`src/App.jsx` — `generateAnkiCard` function (lines ~830-890)**

Add tags to the AI prompt:
```js
// After the existing fieldRequests array:
const tagInstruction = ankiFormat.tagRules
  ? `"tags": array of tag strings. Rules:\n${ankiFormat.tagRules}`
  : `"tags": array of relevant lowercase tags (include "screenlens")`
fieldRequests.push(tagInstruction)
```

Replace hardcoded tags with AI result:
```js
// Replace:
const langTag = (LANGS.find((l) => l.code === language)?.label || language).toLowerCase()
const tags = ['screenlens', langTag]

// With:
const tags = Array.isArray(cardData.tags) && cardData.tags.length > 0
  ? cardData.tags
  : ['screenlens']  // fallback
```

**`src/App.jsx` — Card preview (lines ~1607-1650)**

Add tag display in the card preview, between Back content and Deck selector:
```jsx
{ankiCard.tags?.length > 0 && (
  <div style={{ marginBottom: 6 }}>
    <div style={S.ttAnkiCardLabel}>Tags</div>
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {ankiCard.tags.map((tag, i) => (
        <span key={i} style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 3,
          background: 'rgba(125,133,144,.15)', color: '#c9d1d9',
          border: '1px solid rgba(125,133,144,.2)',
        }}>{tag}</span>
      ))}
    </div>
  </div>
)}
```

### Verification
- Generate card in language mode → tags include POS, language, screenlens, topic
- Generate card in general mode → tags match the mode's tagRules
- Tags display as chips in card preview

---

## Phase 4: Dynamic Field Generation for General Mode

### Goal
Make card generation work with arbitrary fields (not just the 5 hardcoded language fields).

### Changes

**`src/App.jsx` — `generateAnkiCard` function**

Replace the hardcoded field descriptions:
```js
// Current (hardcoded):
if (fmt.fields.pronunciation) fieldRequests.push(`"pronunciation": pronunciation guide...`)
if (fmt.fields.translation) fieldRequests.push(`"translation": translation to ${tgtLang}`)
// etc.

// New (dynamic):
const fieldDescriptions = {
  // Language mode field hints
  pronunciation: `pronunciation guide in English phonetics (e.g. "KAH-lee-do"), include gender variants if applicable`,
  translation: `translation to ${tgtLang}`,
  synonyms: `comma-separated synonyms in ${tgtLang}, grouped by meaning if multiple`,
  definition: activeMode.type === 'language'
    ? `definition in ${srcLang} (the source language, not ${tgtLang})`
    : `clear, concise definition`,
  example: activeMode.type === 'language'
    ? `example sentence in ${srcLang} using the word in context, followed by (${tgtLang} translation in parentheses)`
    : `practical example or scenario illustrating this concept`,
}

Object.entries(fmt.fields).forEach(([field, enabled]) => {
  if (!enabled) return
  const hint = fieldDescriptions[field] || `${field} - provide relevant content for this field`
  fieldRequests.push(`"${field}": ${hint}`)
})
```

Update the template replacement to be dynamic:
```js
// Current (hardcoded):
const front = fmt.frontTemplate
  .replace('{word}', word.text)
  .replace('{partOfSpeech}', word.partOfSpeech || '')
  // etc.

// New (dynamic):
const replacements = {
  word: word.text,
  term: word.text,
  partOfSpeech: word.partOfSpeech || '',
  ...cardData,  // AI-generated fields override
}

let front = fmt.frontTemplate
let back = fmt.backTemplate
Object.entries(replacements).forEach(([key, val]) => {
  const re = new RegExp(`\\{${key}\\}`, 'g')
  front = front.replace(re, String(val || ''))
  back = back.replace(re, String(val || ''))
})
```

**`src/App.jsx` — `autoExplain` function (lines ~754-770)**

Make explanation mode-aware:
```js
// Current:
const prompt = `Word: "${word.text}" (translated: "${word.translation}")
Context: "${getContext()}"
In 1-2 short sentences: what does "${word.text}" mean here...`

// New:
const prompt = activeMode.type === 'language'
  ? `Word: "${word.text}" (translated: "${word.translation}")
Context: "${getContext()}"
In 1-2 short sentences: what does "${word.text}" mean here and what part of speech is it? No markdown.`
  : `Term: "${word.text}"
Context: "${getContext()}"
Study subject: ${activeMode.description || activeMode.name}
In 1-2 short sentences: explain "${word.text}" in the context of ${activeMode.name}. No markdown.`
```

### Verification
- Language mode card generation still works identically
- General mode (Security+) generates cards with custom fields (definition, category, etc.)
- Template placeholders replaced correctly for both modes
- Explain button gives mode-appropriate explanations

---

## Phase 5: AI-Assisted Format Editing

### Goal
Let users modify the mode's card format by chatting with AI.

### Changes

**`src/App.jsx` — New function: `editModeWithAI(instruction)`**

```js
const editModeWithAI = async (instruction) => {
  if (!apiKey || modeCreating) return
  setModeCreating(true)
  try {
    const prompt = `Current study mode config:
${JSON.stringify({ name: activeMode.name, type: activeMode.type, fields: activeMode.fields, frontTemplate: activeMode.frontTemplate, backTemplate: activeMode.backTemplate, tagRules: activeMode.tagRules }, null, 2)}

User's request: "${instruction}"

Modify the config according to the user's request. Return the FULL updated JSON config with all fields (name, type, fields, frontTemplate, backTemplate, tagRules). Keep everything the user didn't ask to change.

Output ONLY raw JSON. No markdown, no backticks.`

    const text = await providerConfig.call(apiKey,
      'You modify study mode configurations. Always respond with valid JSON only.',
      prompt
    )
    const config = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''))

    updateActiveMode({
      name: config.name || activeMode.name,
      type: config.type || activeMode.type,
      fields: config.fields || activeMode.fields,
      frontTemplate: config.frontTemplate || activeMode.frontTemplate,
      backTemplate: config.backTemplate || activeMode.backTemplate,
      tagRules: config.tagRules || activeMode.tagRules,
    })
    console.log('[Mode] updated via AI:', config)
  } catch (err) {
    console.error('[Mode] AI edit failed:', err.message)
    setAnkiError('Format edit failed: ' + err.message)
  } finally {
    setModeCreating(false)
  }
}
```

**`src/App.jsx` — Format editor UI update**

Add an AI chat input at the top of the format editor:
```jsx
{showModeFormatEditor && (
  <div style={{ ...S.keyBar, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: '#d2a8ff' }}>
      Edit Format: {activeMode.name}
    </div>

    {/* AI edit input */}
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={modeEditInput}
        onChange={(e) => setModeEditInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && modeEditInput.trim()) { editModeWithAI(modeEditInput.trim()); setModeEditInput('') } }}
        placeholder="Tell AI what to change (e.g. 'add a mnemonic field', 'make tags include chapter numbers')"
        style={{ ...S.keyInput, flex: 1 }}
        disabled={modeCreating}
      />
      <button
        onClick={() => { if (modeEditInput.trim()) { editModeWithAI(modeEditInput.trim()); setModeEditInput('') } }}
        disabled={modeCreating || !modeEditInput.trim()}
        style={{ ...S.getKeyLink, opacity: modeCreating ? 0.5 : 1 }}
      >
        {modeCreating ? 'Updating...' : 'Update'}
      </button>
    </div>

    {/* Existing manual field toggles, front/back template editors below */}
    {/* ... keep existing format editor fields ... */}

    {/* Tag rules textarea */}
    <div>
      <div style={{ fontSize: 10, color: '#7d8590', marginBottom: 4 }}>Tag generation rules</div>
      <textarea
        value={activeMode.tagRules || ''}
        onChange={(e) => updateActiveMode({ tagRules: e.target.value })}
        style={{ ...S.keyInput, fontSize: 11, minHeight: 60, resize: 'vertical' }}
        placeholder="Instructions for AI tag generation..."
      />
    </div>
  </div>
)}
```

### Verification
- Type "add a mnemonic field" → AI adds mnemonic to fields and backTemplate
- Type "make tags include difficulty levels" → AI updates tagRules
- Manual editing still works alongside AI editing
- Changes persist after page reload

---

## Phase 6: Conditional UI Based on Mode Type

### Goal
Hide language-specific UI when in general mode, adjust OCR behavior.

### Changes

**`src/App.jsx` — Header language selectors (~line 1243)**

Wrap language selectors with mode type check:
```jsx
{activeMode.type === 'language' && (
  <div style={{ display: 'flex', alignItems: 'center', gap: 4, ... }}>
    <select value={language} ...>
      {LANGS.map(...)}
    </select>
    <span>→</span>
    <select value={targetLang} ...>
      {LANGS.filter(...).map(...)}
    </select>
  </div>
)}
```

**`src/App.jsx` — Translation pipeline (~line 500)**

In the `analyzeImage` function, after OCR completes:
- **Language mode**: run the existing translation pipeline (TRANSLATE_PROMPT)
- **General mode**: skip translation. Mark all words as `category: 'foreign'` with `translation: ''` so they still get highlighted and are clickable. The explanation/card generation handles the studying.

```js
// After OCR words are extracted:
if (activeMode.type === 'general') {
  // Skip translation — words are terms to study, not translate
  const mapped = ocrWords.map((w) => ({
    ...w,
    translation: '',
    category: 'foreign',
    partOfSpeech: '',
    synonyms: [],
    pronunciation: '',
  }))
  setOcrWords(mapped)
  setStage('done')
  return
}
// Otherwise, proceed with existing translation pipeline
```

**`src/App.jsx` — Tooltip display (~line 1380)**

For general mode, the tooltip shows the term without translation:
```jsx
{activeWord.category === 'foreign' && activeWord.translation && (
  <div style={S.ttTrans}>→ {activeWord.translation}</div>
)}
// In general mode, translation is empty so this line won't render
// The word text + explain/anki buttons are still shown
```

### Verification
- Language mode: language selectors visible, full translate pipeline, tooltip shows translation
- General mode: language selectors hidden, OCR only (no translation), tooltip shows term with explain/anki buttons
- Switching modes updates the UI immediately

---

## Phase 7: Styles

### Changes to `src/styles/theme.js`

Add/rename styles:
```js
// Reuse existing styles where possible:
// S.keyBar — for mode panel (already used for settings bars)
// S.keyInput — for text inputs
// S.keyDone — for action buttons
// S.getKeyLink — for secondary buttons
// S.ghostBtn — for toolbar buttons

// No new styles strictly needed — the existing design system covers all UI patterns
// Profile styles already work for modes since the UI structure is the same
```

---

## Phase 8: Flashcard Study Mode (Practice with Anki Cards)

### Goal
Let users practice/study using the flashcards from their selected Anki deck. AI asks questions about each card, evaluates answers, and rates difficulty (Again/Hard/Good/Easy) to feed back into Anki's spaced repetition.

### Concept

A **"Study"** button in the toolbar launches a study session. The AI pulls cards from the selected Anki deck via AnkiConnect, asks 3 questions per card, evaluates the user's text answers, and determines an Anki review rating.

Study behavior is controlled by a **study rules file** (`studyrules.json`) that ships with defaults and is user-editable (via AI chat, same pattern as mode format editing). Each mode gets its own study rules.

### Default Study Rules File: `studyrules.json`

This file ships with the app (committed to git) as the default template. User changes are saved to a separate `studyrules.local.json` that overrides it (gitignored).

```json
{
  "questionsPerCard": 3,
  "rating": {
    "allCorrect": "easy",
    "oneWrong": "ai-judge",
    "twoWrong": "hard",
    "allWrong": "again"
  },
  "languageQuestions": [
    "What does \"{front}\" mean?",
    "Use \"{front}\" in a sentence.",
    "What part of speech is \"{front}\"?",
    "Give a synonym for \"{front}\".",
    "Translate this sentence: \"{example}\"",
    "What is the opposite of \"{front}\"?",
    "Complete this sentence using \"{front}\": ___",
    "In what context would you use \"{front}\"?",
    "What is the root or origin of \"{front}\"?",
    "Conjugate \"{front}\" in the present tense (if verb)."
  ],
  "generalQuestions": [
    "Define \"{front}\" in your own words.",
    "Give a real-world example of \"{front}\".",
    "How does \"{front}\" relate to other concepts you've studied?",
    "What would happen if \"{front}\" didn't exist or was removed?",
    "Explain \"{front}\" as if teaching someone new to the subject.",
    "What are the key characteristics of \"{front}\"?",
    "Compare \"{front}\" with a similar concept.",
    "Why is \"{front}\" important in this field?",
    "What are common misconceptions about \"{front}\"?",
    "Describe a scenario where knowledge of \"{front}\" is critical."
  ],
  "evaluationPrompt": "You are evaluating a student's answer to a flashcard question.\n\nCard front: \"{front}\"\nCard back: \"{back}\"\nQuestion: \"{question}\"\nStudent's answer: \"{answer}\"\n\nEvaluate: is the answer correct, partially correct, or wrong?\nRespond with JSON: {\"correct\": true/false, \"feedback\": \"brief explanation\"}"
}
```

### Study Session Flow

1. **Start**: User clicks "Study" button in toolbar
2. **Fetch cards**: Call AnkiConnect `findCards` for the selected deck, then `cardsInfo` to get card data
3. **Per card**:
   a. Show the card front (term/word)
   b. AI selects 3 questions from the mode-appropriate question pool (language or general). Questions use `{front}`, `{back}`, `{example}` placeholders filled from card data
   c. User types answer for each question
   d. AI evaluates each answer using the `evaluationPrompt`
   e. After 3 questions, determine rating:
      - All correct → **Easy** (Anki ease 4)
      - 1 wrong → AI judges based on answer quality: **Good** (3) or **Hard** (2)
      - 2 wrong → **Hard** (2)
      - All wrong → **Again** (1)
   f. Call AnkiConnect `answerCards` to submit the rating
   g. Show feedback summary, move to next card
4. **End**: Show session summary (cards studied, ratings breakdown)

### AnkiConnect API Calls Needed

```js
// Fetch cards due for review in the deck
ankiRequest('findCards', { query: `deck:"${ankiDeck}" is:due` })

// Get card details (front, back, etc.)
ankiRequest('cardsInfo', { cards: [cardId1, cardId2, ...] })

// Submit review answer (1=again, 2=hard, 3=good, 4=easy)
ankiRequest('answerCards', { answers: [{ cardId, ease }] })
```

Add to `src/utils/anki.js`:
```js
export async function ankiFindCards(query) {
  return ankiRequest('findCards', { query })
}

export async function ankiCardsInfo(cards) {
  return ankiRequest('cardsInfo', { cards })
}

export async function ankiAnswerCards(answers) {
  return ankiRequest('answerCards', { answers })
}
```

### Changes to `src/App.jsx`

**New state:**
```js
const [studyActive, setStudyActive] = useState(false)
const [studyCards, setStudyCards] = useState([])      // cards to study
const [studyIdx, setStudyIdx] = useState(0)           // current card index
const [studyQuestions, setStudyQuestions] = useState([]) // 3 questions for current card
const [studyAnswers, setStudyAnswers] = useState([])    // user answers
const [studyResults, setStudyResults] = useState([])    // AI evaluations
const [studyPhase, setStudyPhase] = useState('question') // 'question' | 'feedback' | 'summary'
const [studyInput, setStudyInput] = useState('')
const [studyLoading, setStudyLoading] = useState(false)
const [studyRules, setStudyRules] = useState(null)      // loaded from studyrules
const [showStudyRulesEditor, setShowStudyRulesEditor] = useState(false)
```

**New functions:**
- `startStudySession()` — fetch due cards, pick first, generate questions
- `submitStudyAnswer(answer)` — AI evaluates, store result, advance to next question or feedback
- `rateCard(cardId, results)` — calculate ease from results, call `ankiAnswerCards`
- `nextStudyCard()` — advance to next card or show summary
- `editStudyRulesWithAI(instruction)` — AI modifies study rules, saves to `studyrules.local.json`

**Study UI (renders when `studyActive`):**
Replaces the main content area with a study interface:
```
┌──────────────────────────────────┐
│  Card 3/15          [Exit Study] │
│                                  │
│  ┌────────────────────────────┐  │
│  │  cálido/cálida (adj)      │  │
│  └────────────────────────────┘  │
│                                  │
│  Q2/3: Use "cálido" in a        │
│  sentence.                       │
│                                  │
│  [___________________________]   │
│                      [Submit]    │
│                                  │
│  ✓ Q1: Correct - "warm"         │
│                                  │
└──────────────────────────────────┘
```

After all 3 questions:
```
┌──────────────────────────────────┐
│  Results for: cálido/cálida      │
│                                  │
│  ✓ Q1: What does "cálido" mean? │
│    Your answer: "warm"           │
│    → Correct                     │
│                                  │
│  ✗ Q2: Use "cálido" in a       │
│    sentence.                     │
│    Your answer: "es cálido"      │
│    → Too brief, needs context    │
│                                  │
│  ✓ Q3: Give a synonym           │
│    Your answer: "templado"       │
│    → Correct                     │
│                                  │
│  Rating: Good (2/3 correct)     │
│                   [Next Card →]  │
└──────────────────────────────────┘
```

### Persistence & Defaults

**Files:**
- `studyrules.json` — **committed to git**, contains defaults. Never modified by the app.
- `studyrules.local.json` — **gitignored**, user's customizations. Created on first edit.

**Vite endpoints:**
- `GET /api/studyrules` — reads `studyrules.local.json` if it exists, falls back to `studyrules.json`
- `POST /api/studyrules` — writes to `studyrules.local.json`

**Loading on mount:**
```js
fetch('/api/studyrules').then((r) => r.json()).then(setStudyRules)
```

### Mode-specific study behavior

The study rules file has both `languageQuestions` and `generalQuestions`. When starting a study session:
- `activeMode.type === 'language'` → use `languageQuestions`
- `activeMode.type === 'general'` → use `generalQuestions`

Each mode can also override the question list via the mode config (optional `customQuestions` field). If present, those are used instead of the defaults.

### Toolbar button

Add next to the mode button:
```jsx
{ankiConnected && (
  <button onClick={startStudySession} style={{
    ...S.ghostBtn,
    color: '#7ee787',
    borderColor: 'rgba(126,231,135,0.25)',
  }}>
    Study
  </button>
)}
```

### Verification
1. Click "Study" with Anki running → fetches due cards from selected deck
2. 3 questions per card, text input for answers
3. AI evaluates answers, shows feedback
4. Rating calculated and submitted to Anki via AnkiConnect
5. Session summary at the end
6. Edit study rules via AI ("make questions harder", "add fill-in-the-blank questions")
7. Fresh install → defaults from `studyrules.json` work out of the box
8. User edits → saved to `studyrules.local.json`, persist across sessions

---

## Phase 9: Overlay Mode (Electron Desktop App)

### Goal
Add a transparent overlay mode that sits on top of games, browsers, and other applications. User presses `Ctrl+Shift+S` → the screen is captured and translated words are overlaid directly on top of the target app without interrupting it.

### Prerequisite: Convert to Electron

The current app runs in a browser which cannot create transparent overlay windows. Converting to Electron wraps the existing React/Vite app in a native desktop window.

**New files:**
- `electron/main.js` — Electron main process
- `electron/preload.js` — bridge between main and renderer
- `electron/overlay.js` — overlay window management

**Package changes:**
```json
{
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  },
  "main": "electron/main.js",
  "scripts": {
    "electron:dev": "electron .",
    "electron:build": "vite build && electron-builder"
  }
}
```

### Electron Main Process (`electron/main.js`)

```js
const { app, BrowserWindow, globalShortcut, screen, desktopCapturer } = require('electron')

let mainWindow = null    // normal app window
let overlayWindow = null // transparent overlay

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  // In dev: load Vite dev server. In prod: load built files.
  mainWindow.loadURL('http://localhost:3000')
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  overlayWindow = new BrowserWindow({
    width, height,
    transparent: true,         // transparent background
    frame: false,              // no window chrome
    alwaysOnTop: true,         // float above everything
    skipTaskbar: true,         // don't show in taskbar
    resizable: false,
    focusable: true,           // focusable when showing results
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  overlayWindow.loadURL('http://localhost:3000/#overlay')
  overlayWindow.hide()

  // Make click-through when not showing results
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
}
```

### Overlay Flow

1. **`Ctrl+Shift+S` pressed** (global shortcut, works even in games):
   ```js
   globalShortcut.register('CommandOrControl+Shift+S', async () => {
     // Capture entire screen
     const sources = await desktopCapturer.getSources({
       types: ['screen'],
       thumbnailSize: screen.getPrimaryDisplay().size
     })
     const screenshot = sources[0].thumbnail.toDataURL()

     // Show overlay and send screenshot
     overlayWindow.show()
     overlayWindow.setIgnoreMouseEvents(false) // allow interaction
     overlayWindow.webContents.send('overlay-screenshot', screenshot)
   })
   ```

2. **Overlay renderer** receives screenshot, runs OCR + translate (same pipeline as normal mode)

3. **Overlay renders** translated word boxes on transparent background:
   - The screenshot is NOT shown (it's transparent — the actual game/app is visible behind)
   - Only the colored word bounding boxes and tooltips are rendered
   - The boxes are positioned using the same pixel coordinates from OCR

4. **ESC pressed** → hide overlay, resume click-through:
   ```js
   ipcMain.on('overlay-dismiss', () => {
     overlayWindow.setIgnoreMouseEvents(true, { forward: true })
     overlayWindow.hide()
   })
   ```

### Overlay Renderer Changes (`src/App.jsx`)

When running in overlay mode (`#overlay` hash):
- Background is `transparent` instead of `#0e1117`
- No header, no settings bars — just the word overlay boxes
- Screenshot image is hidden (CSS `opacity: 0`) — serves only as coordinate reference
- Word boxes are positioned absolutely using OCR bounding boxes
- Tooltip appears on hover/click as usual
- ESC sends `ipcRenderer.send('overlay-dismiss')`

```jsx
const isOverlay = window.location.hash === '#overlay'

// In overlay mode:
// - app background: transparent
// - hide header
// - hide main image (but keep coordinate system)
// - only render word boxes + tooltip
```

### Key Technical Details

**Borderless windowed games**: Work perfectly — overlay window sits on top.
**Fullscreen exclusive games**: May not work. Recommend users switch to borderless windowed mode.
**Performance**: OCR + translate happens after capture, so there's a brief processing delay (same as current app).
**Click-through**: When the overlay is "passive" (showing boxes), mouse events pass through to the game. When user hovers a word, the overlay becomes interactive.

### Selective click-through with CSS

Electron supports per-pixel click-through using CSS:
```js
overlayWindow.setIgnoreMouseEvents(true, { forward: true })
```
With `forward: true`, Electron checks if the cursor is over a transparent pixel — if so, clicks pass through. Non-transparent elements (word boxes, tooltips) receive clicks. This means no manual toggle needed.

### App mode switching

Add to toolbar in normal mode:
```jsx
<button onClick={() => ipcRenderer.send('toggle-overlay-mode')} style={S.ghostBtn}>
  Overlay Mode
</button>
```

This is only shown when running in Electron (detect via `window.electronAPI` or `navigator.userAgent`).

### Verification
1. Run `npm run electron:dev` → main window opens with normal app
2. Switch to a game (borderless windowed)
3. Press `Ctrl+Shift+S` → overlay appears on top of game with translated words
4. Hover a word → tooltip shows on overlay
5. Press ESC → overlay hides, game resumes normally
6. Works with browsers, text editors, and borderless windowed games

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/App.jsx` | Replace profiles with modes, AI mode creation, AI tag generation, dynamic fields, AI format editing, conditional UI, study session, overlay mode detection |
| `src/utils/anki.js` | Add `ankiFindCards`, `ankiCardsInfo`, `ankiAnswerCards` functions |
| `src/styles/theme.js` | Study session styles, overlay-specific transparent styles |
| `studyrules.json` | **New, committed** — default study rules (question pools, rating logic, evaluation prompt) |
| `studyrules.local.json` | **Gitignored** — user customizations, created on first edit |
| `vite.config.js` | Add `/api/studyrules` GET/POST endpoint |
| `electron/main.js` | **New** — Electron main process, window management, global shortcuts |
| `electron/preload.js` | **New** — IPC bridge between main/renderer |
| `electron/overlay.js` | **New** — Overlay window creation and management |
| `.gitignore` | Add `studyrules.local.json` |

## Execution Order

1. **Phase 1** first — establishes the mode data model, everything else depends on it
2. **Phase 2** next — creates the mode panel UI and AI creation
3. **Phase 3** — AI tags (independent of Phase 4-5, can be done in parallel)
4. **Phase 4** — dynamic fields for general mode
5. **Phase 5** — AI-assisted format editing
6. **Phase 6** — conditional UI (depends on Phase 1-4 being done)
7. **Phase 7** — final styling polish
8. **Phase 8** — flashcard study mode (depends on Phase 1-2 for mode awareness, and working AnkiConnect)
9. **Phase 9** — Electron overlay mode (independent of phases 1-8, can be started in parallel but requires all phases for full functionality)
