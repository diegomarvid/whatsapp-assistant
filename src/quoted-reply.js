// Builds the WAMessage-shaped envelope Baileys expects in sendMessage's
// { quoted } option. Quoting with the original raw content lets WhatsApp
// render the real quote (media thumbnail, document name, poll question)
// instead of an empty or text-only citation.
export function quotedReplyEnvelope({ jid, quoted, loadRawMessage = () => null }) {
  const key = { remoteJid: jid, id: quoted.id, fromMe: Boolean(quoted.fromMe) }
  if (quoted.participant) key.participant = quoted.participant
  // View-once content is deliberately never re-embedded, matching the rest of
  // this assistant: the quote degrades to a text reference.
  const message = quoted.viewOnce ? null : loadRawMessage() || null
  return { key, message: message || { conversation: quoted.text || '' } }
}
