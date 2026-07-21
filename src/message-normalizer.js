import crypto from 'node:crypto'
import { normalizedReactions, normalizedReceipts } from './message-engagement.js'

export function textOf(message) {
  const content = message.message || {}
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || ''
}

function contextInfoOf(content) {
  return content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.videoMessage?.contextInfo || content.documentMessage?.contextInfo || content.audioMessage?.contextInfo || content.stickerMessage?.contextInfo || null
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedLocation(content) {
  const location = content.liveLocationMessage || content.locationMessage
  if (!location) return null
  return {
    live: Boolean(content.liveLocationMessage),
    latitude: numberOrNull(location.degreesLatitude),
    longitude: numberOrNull(location.degreesLongitude),
    name: location.name || null,
    address: location.address || null,
    url: location.url || null,
    accuracyInMeters: numberOrNull(location.accuracyInMeters),
  }
}

function normalizedContacts(content) {
  const entries = content.contactsArrayMessage?.contacts || (content.contactMessage ? [content.contactMessage] : [])
  if (!entries.length) return []
  return entries.map((contact) => ({ displayName: contact.displayName || null, vcard: contact.vcard || null }))
}

function normalizedPoll(content) {
  const poll = content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3
  if (!poll) return null
  return {
    question: poll.name || null,
    selectableOptionsCount: numberOrNull(poll.selectableOptionsCount),
    options: (poll.options || []).map((option) => option.optionName).filter(Boolean),
  }
}

export function safeMessage(message, { source = 'history', capturedAt = Math.floor(Date.now() / 1000) } = {}) {
  const jid = message.key?.remoteJid
  if (!jid) return null
  const content = message.message || {}
  const contextInfo = contextInfoOf(content)
  const document = content.documentMessage
  const reaction = content.reactionMessage
  const video = content.videoMessage
  const sticker = content.stickerMessage
  const pollUpdate = content.pollUpdateMessage
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
    videoRef: null,
    videoMimetype: video?.mimetype || null,
    videoSeconds: numberOrNull(video?.seconds),
    stickerRef: null,
    stickerMimetype: sticker?.mimetype || null,
    documentRef: null,
    documentMimetype: document?.mimetype || null,
    documentName: document?.fileName || null,
    quotedMessageId: contextInfo?.stanzaId || null,
    reactionToMessageId: reaction?.key?.id || null,
    reactionText: reaction?.text || null,
    location: normalizedLocation(content),
    contacts: normalizedContacts(content),
    poll: normalizedPoll(content),
    pollUpdate: pollUpdate ? { pollCreationMessageKey: pollUpdate.pollCreationMessageKey?.id || null } : null,
    receipts: normalizedReceipts(message.userReceipt),
    reactions: normalizedReactions(message.reactions),
    status: null,
    statusAt: null,
    source,
    capturedAt,
  }
}
