import crypto from 'node:crypto'

export function textOf(message) {
  const content = message.message || {}
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || ''
}

function contextInfoOf(content) {
  return content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.videoMessage?.contextInfo || content.documentMessage?.contextInfo || content.audioMessage?.contextInfo || null
}

export function safeMessage(message, { source = 'history', capturedAt = Math.floor(Date.now() / 1000) } = {}) {
  const jid = message.key?.remoteJid
  if (!jid) return null
  const content = message.message || {}
  const contextInfo = contextInfoOf(content)
  const document = content.documentMessage
  const reaction = content.reactionMessage
  return {
    id: message.key?.id || crypto.randomUUID(),
    jid,
    fromMe: Boolean(message.key?.fromMe),
    participant: message.key?.participant || null,
    timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
    text: textOf(message),
    type: Object.keys(content)[0] || 'unknown',
    pushName: message.pushName || null,
    audioRef: null,
    imageRef: null,
    imageMimetype: content.imageMessage?.mimetype || null,
    documentRef: null,
    documentMimetype: document?.mimetype || null,
    documentName: document?.fileName || null,
    quotedMessageId: contextInfo?.stanzaId || null,
    reactionToMessageId: reaction?.key?.id || null,
    reactionText: reaction?.text || null,
    source,
    capturedAt,
  }
}
