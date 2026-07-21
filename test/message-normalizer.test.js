import assert from 'node:assert/strict'
import test from 'node:test'
import { mimeTypeForFile } from '../src/file-mime.js'
import { safeMessage } from '../src/message-normalizer.js'

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

test('returns null for messages with no chat identity', () => {
  assert.equal(safeMessage({ message: { conversation: 'ignored' } }), null)
})

test('marks whether a message arrived live or through history', () => {
  const message = safeMessage({ key: { id: 'live-1', remoteJid: 'chat@lid' }, message: { conversation: 'hola' } }, { source: 'live', capturedAt: 123 })
  assert.equal(message.source, 'live')
  assert.equal(message.capturedAt, 123)
})

test('detects common outgoing document MIME types', () => {
  assert.equal(mimeTypeForFile('/tmp/reporte.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeTypeForFile('/tmp/nota.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(mimeTypeForFile('/tmp/foto.JPG'), 'image/jpeg')
})
