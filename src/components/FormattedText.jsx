export default function FormattedText({ text, accentColor = '#58a6ff' }) {
  if (!text) return null
  const lines = text.split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (current) current.lines.push('')
      continue
    }
    const headerMatch = trimmed.match(
      /^(?:\*{0,2})?\s*(?:\d+\.\s*)?([A-Z][A-Z\s/&]+(?:FORM|WORDS|USAGE|SENTENCES|PATTERNS|REGISTER|CONJUGATIONS|EXPLANATION|MEANING|SPEECH|ROOT|INFINITIVE|RELATED|REGIONAL|EXAMPLE)[A-Z\s/&]*?)\s*[:*]*\s*(?:\*{0,2})?(.*)$/
    ) || trimmed.match(
      /^(?:\*{0,2})\s*\d+\.\s*([^*:]+?)\s*[:*]+\s*(?:\*{0,2})?\s*(.*)$/
    )

    if (headerMatch) {
      current = { title: headerMatch[1].trim().replace(/\*+/g, ''), lines: [] }
      sections.push(current)
      if (headerMatch[2]?.trim()) current.lines.push(headerMatch[2].trim())
    } else {
      if (!current) {
        current = { title: null, lines: [] }
        sections.push(current)
      }
      current.lines.push(trimmed)
    }
  }

  return (
    <div>
      {sections.map((section, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          {section.title && (
            <div style={{
              fontSize: 13, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '.08em', color: accentColor, marginBottom: 6,
              paddingBottom: 4, borderBottom: `1px solid ${accentColor}33`,
            }}>
              {section.title}
            </div>
          )}
          <div style={{ fontSize: 14, color: '#c9d1d9', lineHeight: 1.8 }}>
            {section.lines.map((line, j) => {
              if (!line) return <div key={j} style={{ height: 6 }} />
              const isBullet = /^[-•–]/.test(line)
              const isExample = /^[""]/.test(line) || /ejemplo|example|translation/i.test(line)
              return (
                <div key={j} style={{
                  paddingLeft: isBullet ? 12 : 0,
                  fontStyle: isExample ? 'italic' : 'normal',
                  color: isExample ? '#8b949e' : '#c9d1d9',
                  marginBottom: 2,
                }}>
                  {line}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
