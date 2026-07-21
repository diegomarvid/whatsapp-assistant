import crypto from 'node:crypto'
import { proto } from 'baileys'
import { normalizedReactions, normalizedReceipts } from './message-engagement.js'

function unwrapSafeContent(message) {
  let content = message || {}
  let ephemeral = false
  let edited = false
  // Do not unwrap view-once containers. Their content is intentionally not
  // exposed through this assistant, even though Baileys can technically unwrap
  // them for protocol operations.
  for (let depth = 0; depth < 5; depth += 1) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) return { content, ephemeral, edited, viewOnce: true }
    if (content.ephemeralMessage?.message) { content = content.ephemeralMessage.message; ephemeral = true; continue }
    if (content.documentWithCaptionMessage?.message) { content = content.documentWithCaptionMessage.message; continue }
    if (content.associatedChildMessage?.message) { content = content.associatedChildMessage.message; continue }
    if (content.groupStatusMessage?.message) { content = content.groupStatusMessage.message; continue }
    if (content.groupStatusMessageV2?.message) { content = content.groupStatusMessageV2.message; continue }
    if (content.editedMessage?.message) { content = content.editedMessage.message; edited = true; continue }
    if (content.protocolMessage?.editedMessage) { content = content.protocolMessage.editedMessage; edited = true; continue }
    break
  }
  return { content, ephemeral, edited, viewOnce: false }
}

function interactiveResponse(content) {
  const buttons = content.buttonsResponseMessage
  if (buttons) return { kind: 'button', id: buttons.selectedButtonId || null, text: buttons.selectedDisplayText || null }
  const list = content.listResponseMessage
  if (list) return { kind: 'list', id: list.singleSelectReply?.selectedRowId || null, text: list.title || null }
  const template = content.templateButtonReplyMessage
  if (template) return { kind: 'template_button', id: template.selectedId || null, text: template.selectedDisplayText || null }
  const native = content.interactiveResponseMessage?.nativeFlowResponseMessage
  if (native) return { kind: 'native_flow', id: native.name || null, paramsJson: native.paramsJson || null }
  return null
}

export function textOfContent(content) {
  const interactive = interactiveResponse(content)
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || interactive?.text || interactive?.id || ''
}

export function textOf(message) {
  return textOfContent(unwrapSafeContent(message.message || {}).content)
}

function cleanUrlCandidate(candidate) {
  let value = String(candidate || '').trim()
  // Markdown-style prose commonly puts a closing punctuation mark after a URL.
  // This is structural cleanup only; it never inspects the meaning of the text.
  while (value && /[.,!?;:'"}\]]$/u.test(value)) value = value.slice(0, -1)
  while (value.endsWith(')') && (value.match(/\(/g) || []).length < (value.match(/\)/g) || []).length) value = value.slice(0, -1)
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

export function linksInText(text) {
  const candidates = String(text || '').match(/https?:\/\/[^\s<>"']+/gu) || []
  return [...new Set(candidates.map(cleanUrlCandidate).filter(Boolean))]
}

function linksOfContent(content, text) {
  const extended = content.extendedTextMessage || {}
  return [...new Set([
    ...linksInText(text),
    cleanUrlCandidate(extended.canonicalUrl),
    cleanUrlCandidate(extended.matchedText),
  ].filter(Boolean))]
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

function normalizedCall(message, content) {
  const type = Number(message.messageStubType)
  const stub = proto.WebMessageInfo.StubType
  if (!content.call && ![stub.CALL_MISSED_VOICE, stub.CALL_MISSED_VIDEO, stub.CALL_MISSED_GROUP_VOICE, stub.CALL_MISSED_GROUP_VIDEO].includes(type)) return null
  return {
    kind: 'missed',
    video: [stub.CALL_MISSED_VIDEO, stub.CALL_MISSED_GROUP_VIDEO].includes(type),
    group: [stub.CALL_MISSED_GROUP_VOICE, stub.CALL_MISSED_GROUP_VIDEO].includes(type),
  }
}

export function safeMessage(message, { source = 'history', capturedAt = Math.floor(Date.now() / 1000) } = {}) {
  const jid = message.key?.remoteJid
  if (!jid) return null
  const wrapper = unwrapSafeContent(message.message || {})
  const content = wrapper.content
  const contextInfo = contextInfoOf(content)
  const document = content.documentMessage
  const reaction = content.reactionMessage
  const video = content.videoMessage
  const sticker = content.stickerMessage
  const pollUpdate = content.pollUpdateMessage
  const text = textOfContent(content)
  return {
    id: message.key?.id || crypto.randomUUID(),
    jid,
    fromMe: Boolean(message.key?.fromMe),
    participant: message.key?.participant || null,
    timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
    text,
    links: linksOfContent(content, text),
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
    pollVotes: [],
    interactiveResponse: interactiveResponse(content),
    call: normalizedCall(message, content),
    ephemeral: wrapper.ephemeral,
    edited: wrapper.edited,
    viewOnce: wrapper.viewOnce,
    deleted: false,
    deletedAt: null,
    receipts: normalizedReceipts(message.userReceipt),
    reactions: normalizedReactions(message.reactions),
    status: null,
    statusAt: null,
    source,
    capturedAt,
  }
}
