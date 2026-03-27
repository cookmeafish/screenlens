// Collects OCR pipeline logs and writes them to logs/ directory via Vite dev server
const lines = []

export function ocrLog(msg, data) {
  const entry = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg
  lines.push(entry)
  console.log(`[ScreenLens] ${entry}`)
}

export function ocrLogTable(label, rows) {
  lines.push(`${label}:`)
  if (rows.length === 0) {
    lines.push('  (empty)')
  } else {
    // Header
    const keys = Object.keys(rows[0])
    lines.push('  ' + keys.join('\t'))
    for (const row of rows) {
      lines.push('  ' + keys.map((k) => String(row[k] ?? '')).join('\t'))
    }
  }
  console.log(`[ScreenLens] ${label}:`)
  console.table(rows)
}

export async function ocrLogFlush() {
  if (lines.length === 0) return
  const content = lines.join('\n')
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    })
  } catch (e) {
    console.warn('[ScreenLens] Failed to write log file:', e.message)
  }
  lines.length = 0
}
