// Only an incoming direct message may name its chat. A fromMe pushName is the
// account owner's own display name, and a group participant's pushName
// identifies that participant, never the group; using either as the chat name
// makes alias/name resolution point at the wrong conversation.
export function chatNameFromMessage({ jid, fromMe, participant, pushName } = {}) {
  if (!pushName || fromMe || participant) return null
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return null
  return pushName
}

// One-shot repair for mirrors written before chatNameFromMessage existed:
// direct chats that carry the account owner's own display name were named by
// a fromMe pushName. Replace each with evidence from the chat itself (latest
// incoming pushName, then contact name). A chat whose counterpart genuinely
// shares the owner's name keeps it, because its own evidence says so.
export function repairedChatNames({ chats = {}, messages = [], contacts = {}, ownName = null } = {}) {
  if (!ownName) return []
  const incomingNameByJid = new Map()
  const incomingNameAt = new Map()
  for (const message of messages) {
    const name = chatNameFromMessage(message)
    if (!name) continue
    if ((incomingNameAt.get(message.jid) || 0) <= (message.timestamp || 0)) {
      incomingNameAt.set(message.jid, message.timestamp || 0)
      incomingNameByJid.set(message.jid, name)
    }
  }
  const repairs = []
  for (const chat of Object.values(chats)) {
    const jid = chat?.jid
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue
    if (chat.name !== ownName) continue
    const replacement = incomingNameByJid.get(jid) || contacts[jid]?.name || null
    if (replacement === chat.name) continue
    repairs.push({ jid, name: replacement })
  }
  return repairs
}
