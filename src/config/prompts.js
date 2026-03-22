export const TRANSLATE_PROMPT = `Translate words from one language to another. Classify each word by category and part of speech.

You receive JSON: {"words": [{"i":0,"w":"word1"},...], "from": "Spanish", "to": "English", "context": "..."}

Return a JSON array. For each input word, return an object:
- "i": the SAME index number from the input (MUST match)
- "w": the SAME original word from the input (MUST match)
- "t": translation in the TARGET language. If a name, keep the original. If already in target language, keep as-is.
- "s": 2-3 synonyms in the target language (empty array for articles/prepositions/names/numbers)
- "c": category — one of: "foreign" (needs translation), "name" (proper noun/character/place/brand), "target" (already in target language), "number" (digits/stats)
- "p": part of speech — one of: "noun", "verb", "adj", "adv", "prep", "art", "conj", "pron", "other"
- "r": approximate pronunciation guide for the original word (e.g. "kreh-EE-ahn" for "creían"). Use simple English phonetics.

CRITICAL: Every output object MUST include "i" and "w" copied exactly from the input. Always return valid JSON array. Never add commentary.

Words with punctuation attached (e.g. "púas,") — translate the word part, ignore punctuation.

Output ONLY the raw JSON array. No markdown, no backticks, no explanation.

Example:
Input: {"words":[{"i":0,"w":"Aventura"},{"i":1,"w":"en"},{"i":2,"w":"Naramon"}],"from":"Spanish","to":"English","context":"Aventura en Naramon"}
Output: [{"i":0,"w":"Aventura","t":"Adventure","s":["quest","journey"],"c":"foreign","p":"noun","r":"ah-ven-TOO-rah"},{"i":1,"w":"en","t":"in","s":[],"c":"foreign","p":"prep","r":"en"},{"i":2,"w":"Naramon","t":"Naramon","s":[],"c":"name","p":"noun","r":"nah-rah-MOHN"}]`

// Part-of-speech color map
export const POS_COLORS = {
  noun: { bg: 'rgba(88,166,255,.15)', border: 'rgba(88,166,255,.3)', text: '#58a6ff', label: 'Noun' },
  verb: { bg: 'rgba(210,168,255,.15)', border: 'rgba(210,168,255,.3)', text: '#d2a8ff', label: 'Verb' },
  adj:  { bg: 'rgba(255,166,87,.15)', border: 'rgba(255,166,87,.3)', text: '#ffa657', label: 'Adjective' },
  adv:  { bg: 'rgba(255,220,100,.15)', border: 'rgba(255,220,100,.3)', text: '#ffdc64', label: 'Adverb' },
  pron: { bg: 'rgba(100,210,210,.15)', border: 'rgba(100,210,210,.3)', text: '#64d2d2', label: 'Pronoun' },
  prep: { bg: 'rgba(125,133,144,.06)', border: 'rgba(125,133,144,.12)', text: '#7d8590', label: 'Preposition' },
  art:  { bg: 'rgba(125,133,144,.06)', border: 'rgba(125,133,144,.12)', text: '#7d8590', label: 'Article' },
  conj: { bg: 'rgba(125,133,144,.06)', border: 'rgba(125,133,144,.12)', text: '#7d8590', label: 'Conjunction' },
  other:{ bg: 'rgba(125,133,144,.08)', border: 'rgba(125,133,144,.15)', text: '#7d8590', label: 'Other' },
}

export const CATEGORY_COLORS = {
  name:   { bg: 'rgba(126,231,135,.12)', border: 'rgba(126,231,135,.25)', text: '#7ee787', label: 'Name' },
  target: { bg: 'transparent', border: 'transparent', text: '#7ee787', label: null },
  number: { bg: 'transparent', border: 'transparent', text: '#7d8590', label: 'Number' },
}
