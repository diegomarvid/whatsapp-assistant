import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ackStatusStanzas, baileysHandlesStatusStanzas, STATUS_STANZA_EVENT } from '../src/status-stanza-ack.js'

// The frames WhatsApp sent in the 2026-11-12 incident (ids are synthetic).
const statusStanza = (attrs = {}) => ({
  tag: 'status',
  attrs: { id: 'A5DB6F8EB20DC2076E25A3166A389034', from: 'status@broadcast', participant: '100000000000001@lid', type: 'media', t: '1794516660', ...attrs },
  content: [{ tag: 'enc', attrs: { type: 'skmsg', v: '2' }, content: new Uint8Array([1, 2, 3]) }],
})

function baileysLikeSocket() {
  const ws = new EventEmitter()
  const sent = []
  return { ws, sent, sendNode: async (node) => { sent.push(node) } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('without the ack, a <status> stanza is left pending (the incident)', async () => {
  const socket = baileysLikeSocket()
  // Baileys rc14 registers no CB:status listener: nothing answers the frame.
  assert.equal(socket.ws.emit(STATUS_STANZA_EVENT, statusStanza()), false)
  await settle()
  assert.deepEqual(socket.sent, [])
})

test('acks every <status> stanza exactly as Baileys acks other stanzas, without an error code', async () => {
  const socket = baileysLikeSocket()
  const acked = []
  assert.equal(ackStatusStanzas(socket, { onAck: (node) => acked.push(node.attrs.id) }), true)
  socket.ws.emit(STATUS_STANZA_EVENT, statusStanza())
  socket.ws.emit(STATUS_STANZA_EVENT, statusStanza({ id: 'AC820019F031A29AE5F1E507685D1BAB', type: 'text', offline: '1' }))
  await settle()
  assert.deepEqual(socket.sent, [
    { tag: 'ack', attrs: { id: 'A5DB6F8EB20DC2076E25A3166A389034', to: 'status@broadcast', class: 'status', participant: '100000000000001@lid', type: 'media' } },
    { tag: 'ack', attrs: { id: 'AC820019F031A29AE5F1E507685D1BAB', to: 'status@broadcast', class: 'status', participant: '100000000000001@lid', type: 'text' } },
  ])
  assert.ok(socket.sent.every((node) => !('error' in node.attrs)), 'a NACK keeps the stanza pending on the server')
  assert.deepEqual(acked, ['A5DB6F8EB20DC2076E25A3166A389034', 'AC820019F031A29AE5F1E507685D1BAB'])
})

test('steps aside when Baileys already handles <status> stanzas', async () => {
  const socket = baileysLikeSocket()
  socket.ws.on(STATUS_STANZA_EVENT, () => {})
  assert.equal(baileysHandlesStatusStanzas(socket), true)
  assert.equal(ackStatusStanzas(socket), false)
  socket.ws.emit(STATUS_STANZA_EVENT, statusStanza())
  await settle()
  assert.deepEqual(socket.sent, [], 'never ack the same stanza twice')
})

test('a failed ack is logged and never throws into the frame dispatcher', async () => {
  const socket = baileysLikeSocket()
  socket.sendNode = async () => { throw new Error('Connection Closed') }
  const warnings = []
  ackStatusStanzas(socket, { logger: { warn: (detail, message) => warnings.push({ detail, message }) } })
  assert.doesNotThrow(() => socket.ws.emit(STATUS_STANZA_EVENT, statusStanza()))
  await settle()
  await settle()
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].message, 'Could not ack a status stanza')
  assert.equal(warnings[0].detail.stanzaType, 'media')
})

test('ignores a socket without the public frame surface and frames without an id', async () => {
  assert.equal(ackStatusStanzas(null), false)
  assert.equal(ackStatusStanzas({ ws: new EventEmitter() }), false)
  const socket = baileysLikeSocket()
  ackStatusStanzas(socket)
  socket.ws.emit(STATUS_STANZA_EVENT, { tag: 'status', attrs: {} })
  await settle()
  assert.deepEqual(socket.sent, [])
})
