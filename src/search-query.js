// Builds an SQLite FTS5 MATCH expression from the terms a person typed. The
// index folds case and accents, so «Tomás» finds «tomas». Each argument is one
// term; an argument with several words («"precio final"») is a phrase. Terms
// are whole words joined with AND unless `any` asks for OR; `prefix` also
// matches longer words («reserv» → «reserva», «reservas»). `raw` passes FTS5
// syntax through untouched (OR, NOT, NEAR, "phrases", prefix*). This is purely
// lexical: it never decides what a message means.
export function ftsQuery(terms, { any = false, prefix = false, raw = false } = {}) {
  const values = (Array.isArray(terms) ? terms : [terms]).map((term) => String(term ?? '').trim()).filter(Boolean)
  if (!values.length) throw new Error('Search needs at least one term.')
  if (raw) return values.join(' ')
  const parts = values.map((term) => {
    const words = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (!words.length) return null
    const quoted = `"${words.join(' ')}"`
    return prefix ? `${quoted}*` : quoted
  }).filter(Boolean)
  if (!parts.length) throw new Error('Search terms must contain letters or digits.')
  return parts.join(any ? ' OR ' : ' AND ')
}
