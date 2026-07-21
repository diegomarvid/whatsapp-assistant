import assert from 'node:assert/strict'
import test from 'node:test'
import { quotedReplyEnvelope } from '../src/quoted-reply.js'

test('quotes the original raw content so media replies render a real quote', () => {
  const raw = { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } }
  const envelope = quotedReplyEnvelope({
    jid: '1@lid',
    quoted: { id: 'abc', fromMe: false, participant: null, text: 'foto', viewOnce: false },
    loadRawMessage: () => raw,
  })
  assert.deepEqual(envelope.key, { remoteJid: '1@lid', id: 'abc', fromMe: false })
  assert.equal(envelope.message, raw)
})

test('keeps the group participant on the quoted key', () => {
  const envelope = quotedReplyEnvelope({
    jid: 'work@g.us',
    quoted: { id: 'abc', fromMe: false, participant: '9@lid', text: 'hola' },
  })
  assert.deepEqual(envelope.key, { remoteJid: 'work@g.us', id: 'abc', fromMe: false, participant: '9@lid' })
})

test('falls back to the cached text when no raw envelope is available', () => {
  const envelope = quotedReplyEnvelope({
    jid: '1@lid',
    quoted: { id: 'abc', fromMe: true, text: 'texto original' },
    loadRawMessage: () => null,
  })
  assert.deepEqual(envelope.message, { conversation: 'texto original' })
})

test('never re-embeds view-once content in a quote', () => {
  const envelope = quotedReplyEnvelope({
    jid: '1@lid',
    quoted: { id: 'abc', fromMe: false, text: '', viewOnce: true },
    loadRawMessage: () => ({ viewOnceMessage: { message: { imageMessage: {} } } }),
  })
  assert.deepEqual(envelope.message, { conversation: '' })
})
