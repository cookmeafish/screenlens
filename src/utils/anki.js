// AnkiConnect API wrapper — communicates via Vite proxy at /api/anki

function ankiLog(msg, data) {
  const entry = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg
  console.log(`[Anki] ${entry}`)
}

async function ankiRequest(action, params = {}) {
  ankiLog(`request: ${action}`, params)
  const res = await fetch('/api/anki', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  })
  const data = await res.json()
  ankiLog(`response: ${action}`, data)
  if (data.error) throw new Error(data.error)
  return data.result
}

export async function ankiPing() {
  try {
    const version = await ankiRequest('version')
    ankiLog(`connected, AnkiConnect version: ${version}`)
    return true
  } catch (err) {
    ankiLog(`ping failed: ${err.message}`)
    return false
  }
}

export async function ankiGetDecks() {
  const decks = await ankiRequest('deckNames')
  ankiLog(`found ${decks.length} decks`, decks)
  return decks
}

export async function ankiCreateDeck(deckName) {
  ankiLog(`creating deck "${deckName}"`)
  return ankiRequest('createDeck', { deck: deckName })
}

export async function ankiAddNote(deckName, front, back, tags = []) {
  ankiLog(`adding note to deck "${deckName}"`, { front, back, tags })
  const noteId = await ankiRequest('addNote', {
    note: {
      deckName,
      modelName: 'Basic',
      fields: { Front: front, Back: back },
      options: { allowDuplicate: false },
      tags,
    },
  })
  ankiLog(`note added, id: ${noteId}`)
  return noteId
}
