export function isDirectChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast')
}

export function parseSince(value) {
  const match = String(value || '').match(/^(\d+)(h|d)$/)
  if (!match) throw new Error('Use --since <n>h or <n>d')
  return Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
}

// Without --since the whole locally retained window is searched: the mirror is
// already bounded by the retention policy, so "no explicit window" must never
// silently mean "nothing".
export function searchAllMatches({ messages, query, nowSeconds, sinceSeconds = null, scope = 'all', allowedGroups = null, limit = 100 }) {
  const cutoff = sinceSeconds ? nowSeconds - sinceSeconds : 0
  const needle = String(query || '').toLocaleLowerCase()
  return (messages || [])
    .filter((message) => message.timestamp >= cutoff
      && (message.text || '').toLocaleLowerCase().includes(needle)
      && (scope === 'all'
        || (scope === 'direct' && isDirectChat(message.jid))
        || (scope === 'groups' && Boolean(message.jid?.endsWith('@g.us')) && (!allowedGroups || allowedGroups.has(message.jid)))))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}
