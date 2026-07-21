export function isDirectChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast')
}

export function parseSince(value) {
  const match = String(value || '').match(/^(\d+)(h|d)$/)
  if (!match) throw new Error('Use --since <n>h or <n>d')
  return Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
}

// Structural text folding (case + diacritics + separators) used for identity
// and term matching. It never interprets meaning; it only makes byte-level
// comparison insensitive to accents and punctuation.
export function normalizeSearchText(value) {
  return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

// Without --since the whole locally retained window is searched: the mirror is
// already bounded by the retention policy, so "no explicit window" must never
// silently mean "nothing".
export function searchAllMatches({ messages, query, nowSeconds, sinceSeconds = null, scope = 'all', allowedGroups = null, limit = 100, normalized = false }) {
  const cutoff = sinceSeconds ? nowSeconds - sinceSeconds : 0
  const fold = normalized ? normalizeSearchText : (value) => String(value || '').toLocaleLowerCase()
  const needle = fold(query)
  return (messages || [])
    .filter((message) => message.timestamp >= cutoff
      && fold(message.text).includes(needle)
      && (scope === 'all'
        || (scope === 'direct' && isDirectChat(message.jid))
        || (scope === 'groups' && Boolean(message.jid?.endsWith('@g.us')) && (!allowedGroups || allowedGroups.has(message.jid)))))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}
