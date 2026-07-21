import assert from 'node:assert/strict'
import test from 'node:test'
import { mimeTypeForFile } from '../src/file-mime.js'
import { safeMessage } from '../src/message-normalizer.js'
import { coverageForChat } from '../src/chat-coverage.js'
import { applyReaction, applyReceipt, receiptReport } from '../src/message-engagement.js'

test('normalizes document metadata and reply context without crashing', () => {
  const message = safeMessage({
    key: { id: 'doc-1', remoteJid: '59800000000@s.whatsapp.net' },
    messageTimestamp: 1,
    message: { documentMessage: { fileName: 'resumen.pdf', mimetype: 'application/pdf', contextInfo: { stanzaId: 'prior-1' } } },
  })
  assert.equal(message.type, 'documentMessage')
  assert.equal(message.documentName, 'resumen.pdf')
  assert.equal(message.documentMimetype, 'application/pdf')
  assert.equal(message.quotedMessageId, 'prior-1')
})

test('normalizes images and reactions without requiring optional fields', () => {
  const image = safeMessage({ key: { id: 'image-1', remoteJid: 'chat@lid' }, message: { imageMessage: { caption: 'hola', mimetype: 'image/jpeg' } } })
  const reaction = safeMessage({ key: { id: 'reaction-1', remoteJid: 'chat@lid' }, message: { reactionMessage: { text: '👍', key: { id: 'image-1' } } } })
  assert.equal(image.text, 'hola')
  assert.equal(image.imageMimetype, 'image/jpeg')
  assert.equal(reaction.reactionToMessageId, 'image-1')
  assert.equal(reaction.reactionText, '👍')
})

test('normalizes media and structured WhatsApp facts without interpreting them', () => {
  const video = safeMessage({
    key: { id: 'video-1', remoteJid: 'group@g.us' },
    message: { videoMessage: { caption: 'tour', mimetype: 'video/mp4', seconds: 12, contextInfo: { stanzaId: 'prior' } } },
  })
  const location = safeMessage({
    key: { id: 'location-1', remoteJid: 'chat@lid' },
    message: { locationMessage: { degreesLatitude: -34.9, degreesLongitude: -56.2, name: 'Oficina', address: 'Centro' } },
  })
  const poll = safeMessage({
    key: { id: 'poll-1', remoteJid: 'group@g.us' },
    message: { pollCreationMessage: { name: '¿Vamos?', selectableOptionsCount: 1, options: [{ optionName: 'Sí' }, { optionName: 'No' }] } },
  })
  assert.equal(video.videoMimetype, 'video/mp4')
  assert.equal(video.videoSeconds, 12)
  assert.equal(video.quotedMessageId, 'prior')
  assert.deepEqual(location.location, { live: false, latitude: -34.9, longitude: -56.2, name: 'Oficina', address: 'Centro', url: null, accuracyInMeters: null })
  assert.deepEqual(poll.poll, { question: '¿Vamos?', selectableOptionsCount: 1, options: ['Sí', 'No'] })
})

test('returns null for messages with no chat identity', () => {
  assert.equal(safeMessage({ message: { conversation: 'ignored' } }), null)
})

test('marks whether a message arrived live or through history', () => {
  const message = safeMessage({ key: { id: 'live-1', remoteJid: 'chat@lid' }, message: { conversation: 'hola' } }, { source: 'live', capturedAt: 123 })
  assert.equal(message.source, 'live')
  assert.equal(message.capturedAt, 123)
})

test('normalizes WhatsApp receipt and reaction facts from history', () => {
  const message = safeMessage({
    key: { id: 'engagement-1', remoteJid: 'group@g.us' },
    message: { conversation: 'estado' },
    userReceipt: [{ userJid: 'ana@lid', receiptTimestamp: 100, readTimestamp: 110 }],
    reactions: [{ key: { participant: 'ana@lid' }, text: '👍', senderTimestampMs: 120000 }],
  })
  assert.deepEqual(message.receipts, { 'ana@lid': { deliveredAt: 100, readAt: 110, playedAt: null } })
  assert.deepEqual(message.reactions, [{ participant: 'ana@lid', emoji: '👍', timestamp: 120 }])
})

test('keeps only the current reaction from each participant and supports removal', () => {
  const message = { reactions: [] }
  assert.equal(applyReaction(message, { key: { participant: 'ana@lid' }, text: '❤️', senderTimestampMs: 1000 }), true)
  assert.equal(applyReaction(message, { key: { participant: 'ana@lid' }, text: '👍', senderTimestampMs: 2000 }), true)
  assert.deepEqual(message.reactions, [{ participant: 'ana@lid', emoji: '👍', timestamp: 2 }])
  assert.equal(applyReaction(message, { key: { participant: 'ana@lid' }, text: '' }), true)
  assert.deepEqual(message.reactions, [])
})

test('stores individual receipt timestamps and reports lack of a receipt without claiming unread', () => {
  const message = { receipts: {} }
  assert.equal(applyReceipt(message, { userJid: 'ana@lid', receiptTimestamp: 100, readTimestamp: 120, playedTimestamp: 130 }), true)
  assert.deepEqual(message.receipts['ana@lid'], { deliveredAt: 100, readAt: 120, playedAt: 130 })
  const report = receiptReport({ message, participants: ['ana@lid', 'bea@lid'] })
  assert.deepEqual(report.readBy, ['ana@lid'])
  assert.deepEqual(report.notReportedReadBy, ['bea@lid'])
  assert.match(report.note, /no prueba/i)
})

test('marks a chat stale when WhatsApp reports a newer chat cursor than the local cache', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 100, lastHistorySyncAt: 101, lastGapEndedAt: 100 },
    chat: { remoteLastTimestamp: 120, lastObservedLiveAt: 102 },
    messages: [{ timestamp: 110 }],
  })
  assert.equal(coverage.status, 'stale')
  assert.equal(coverage.fresh, false)
  assert.deepEqual(coverage.reasons, ['remote_chat_ahead_of_cache'])
})

test('marks the cache unavailable while the bridge is disconnected', () => {
  const coverage = coverageForChat({
    connection: 'disconnected',
    sync: { connectedAt: 200, ingestionHealthy: false },
    chat: { remoteLastTimestamp: 100, lastObservedLiveAt: 202 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.status, 'unknown')
  assert.equal(coverage.fresh, false)
  assert.deepEqual(coverage.reasons, ['bridge_not_connected', 'ingestion_unhealthy'])
})

test('accepts a current seven-day chat snapshot when its cursor matches the cache', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 200, ingestionHealthy: true, lastPersistedAt: 201 },
    chat: { remoteLastTimestamp: 100, lastObservedLiveAt: 202 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.status, 'fresh')
  assert.equal(coverage.fresh, true)
  assert.equal(coverage.retentionDays, 7)
})

test('marks a bridge with a failed ingestion handler unavailable even when it is connected', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 200, ingestionHealthy: false },
    chat: { remoteLastTimestamp: 100, lastObservedLiveAt: 202 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.status, 'unknown')
  assert.equal(coverage.fresh, false)
  assert.deepEqual(coverage.reasons, ['ingestion_unhealthy'])
})

test('does not call an inherited cache fresh until this connection observed the chat live', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 200, ingestionHealthy: true },
    chat: { remoteLastTimestamp: 100 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.fresh, false)
  assert.deepEqual(coverage.reasons, ['chat_not_observed_after_connection'])
})

test('accepts a complete history snapshot received after this connection opened', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 200, ingestionHealthy: true, lastHistorySyncAt: 201 },
    chat: { remoteLastTimestamp: 100, lastObservedHistoryAt: 201 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.status, 'fresh')
  assert.equal(coverage.fresh, true)
})

test('does not trust history observed before the current connection', () => {
  const coverage = coverageForChat({
    connection: 'open',
    sync: { connectedAt: 200, ingestionHealthy: true },
    chat: { remoteLastTimestamp: 100, lastObservedHistoryAt: 199 },
    messages: [{ timestamp: 100 }],
  })
  assert.equal(coverage.fresh, false)
  assert.deepEqual(coverage.reasons, ['chat_not_observed_after_connection'])
})

test('detects common outgoing document MIME types', () => {
  assert.equal(mimeTypeForFile('/tmp/reporte.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeTypeForFile('/tmp/nota.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(mimeTypeForFile('/tmp/foto.JPG'), 'image/jpeg')
  assert.equal(mimeTypeForFile('/tmp/demo.mp4'), 'video/mp4')
  assert.equal(mimeTypeForFile('/tmp/nota.ogg'), 'audio/ogg; codecs=opus')
})
