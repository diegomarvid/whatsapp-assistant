import assert from 'node:assert/strict'
import test from 'node:test'
import { IdempotentSender } from '../src/outbound-idempotency.js'
import { DeliveryError, verifiedSend } from '../src/verified-send.js'
import { fakeSocket, silentLogger as logger } from './helpers/fake-socket.js'

// Synthetic identities: a contact's LID and its real phone JID, plus the
// "phone" fabricated by re-encoding the LID's digits (the 2026-11-02 incident).
const LID = '100000000000001@lid'
const PHONE = '59800000002@s.whatsapp.net'
const FABRICATED = '100000000000001@s.whatsapp.net'

test('Baileys resolves a send to a number with zero devices, so its result alone cannot mean sent', async () => {
  const socket = fakeSocket({ devices: {} })
  const result = await socket.sendMessage(FABRICATED, { text: 'Hola' })
  assert.equal(result.key.remoteJid, FABRICATED, 'the raw socket reports success for a recipient nobody owns')
})

test('a recipient without devices is refused before anything is sent', async () => {
  const socket = fakeSocket({ devices: {} })
  await assert.rejects(
    verifiedSend({ socket, jid: FABRICATED, content: { text: 'Hola' }, logger }),
    (error) => error instanceof DeliveryError && error.code === 'no_recipient_devices' && error.retryable && !error.ambiguous,
  )
  assert.equal(socket.sends.length, 0)
  assert.deepEqual(socket.deviceQueries.map((query) => query.useCache), [true, false], 'a stale cache gets one fresh device query')
})

test('a device lookup failure happens before sending and is retryable', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 } })
  socket.getUSyncDevices = async () => { throw new Error('usync timed out') }
  await assert.rejects(verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }),
    (error) => error.code === 'device_lookup_failed' && error.retryable && !error.ambiguous)
  assert.equal(socket.sends.length, 0)
})

test('a LID with devices is sent as a LID and confirmed by the server ack', async () => {
  const socket = fakeSocket({ devices: { [LID]: 2 } })
  const result = await verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger })
  assert.equal(socket.sends.length, 1)
  assert.equal(socket.sends[0].jid, LID)
  assert.equal(result.key.id, socket.sends[0].options.messageId)
  assert.deepEqual(result.delivery, { jid: LID, requestedJid: LID, fallbackFrom: null, recipientDevices: 2, serverAckAt: 1793620804 })
})

test('a LID without devices falls back to its mapped phone JID, never to its digits', async () => {
  const socket = fakeSocket({ devices: { [PHONE]: 1 }, mapping: { [LID]: `59800000002:0@s.whatsapp.net` } })
  const result = await verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger })
  assert.equal(socket.sends[0].jid, PHONE)
  assert.equal(result.delivery.fallbackFrom, LID)
  assert.equal(result.delivery.jid, PHONE)
})

test('a LID without devices and without a usable equivalent fails with a clear reason', async () => {
  const socket = fakeSocket({ devices: {}, mapping: { [LID]: PHONE } })
  await assert.rejects(verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }), (error) => {
    assert.equal(error.code, 'no_recipient_devices')
    assert.match(error.message, new RegExp(`no device for ${LID} nor for its equivalent ${PHONE}`))
    return true
  })
  assert.equal(socket.sends.length, 0)
})

test('a server error ack is a definitive, non-retryable failure', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 }, ack: 'error', ackError: '463' })
  await assert.rejects(verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }),
    (error) => error.code === 'server_rejected' && !error.retryable && !error.ambiguous && /463/.test(error.message))
})

test('a missing server ack or a closed connection is ambiguous', async () => {
  const silent = fakeSocket({ devices: { [LID]: 1 }, ack: 'none' })
  await assert.rejects(verifiedSend({ socket: silent, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 20, logger }),
    (error) => error.code === 'no_server_ack' && error.ambiguous && !error.retryable)
  const closed = fakeSocket({ devices: { [LID]: 1 }, ack: 'close' })
  await assert.rejects(verifiedSend({ socket: closed, jid: LID, content: { text: 'Hola' }, logger }),
    (error) => error.code === 'no_server_ack' && error.ambiguous && /connection closed/.test(error.message))
  assert.equal(silent.ws.listenerCount('CB:ack,class:message'), 0, 'ack listeners are always removed')
})

test('an ack for another message ID does not confirm this send', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 }, ack: 'none' })
  const pending = verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 30, logger })
  setImmediate(() => socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: 'OTHER', t: '1' } }))
  await assert.rejects(pending, (error) => error.code === 'no_server_ack')
})

test('groups and the own chat keep Baileys fan-out without a contact-device preflight', async () => {
  const socket = fakeSocket({ devices: {} })
  await verifiedSend({ socket, jid: '120363000000000001@g.us', content: { text: 'Hola' }, logger })
  await verifiedSend({ socket, jid: '59800000001@s.whatsapp.net', content: { text: 'Nota' }, logger })
  assert.equal(socket.sends.length, 2)
  assert.equal(socket.deviceQueries.length, 0)
})

test('a reserved message ID is kept, as automation sends require', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 } })
  const result = await verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, options: { messageId: '3EB0RESERVED' }, logger })
  assert.equal(result.key.id, '3EB0RESERVED')
})

function retryStore() {
  const values = new Map()
  return { values, get: (key) => values.get(key), set: (key, value) => values.set(key, structuredClone(value)), del: (key) => values.delete(key) }
}

test('an ambiguous verified send stays pending, so a repeated request is never resent', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const socket = fakeSocket({ devices: { [LID]: 1 }, ack: 'none' })
  await assert.rejects(sender.execute('request_ambiguous_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 10, logger })))
  assert.equal(store.get('request_ambiguous_1').status, 'pending')
  const repeated = await sender.execute('request_ambiguous_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }))
  assert.equal(repeated.pending, true)
  assert.equal(socket.sends.length, 1)
})

test('a send refused before leaving the device can be requested again', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const devices = {}
  const socket = fakeSocket({ devices })
  await assert.rejects(sender.execute('request_no_device_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger })), /no device/)
  assert.equal(store.get('request_no_device_1'), undefined)
  devices[LID] = 1
  const retried = await sender.execute('request_no_device_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }))
  assert.equal(retried.result.delivery.jid, LID)
})

// Review findings on PR #3: an error after the stanza was written must never
// release a retry, and an upload must not consume the ack window.
test('an error after WhatsApp acked the send still counts as sent and is never resent', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const socket = fakeSocket({ devices: { [LID]: 1 }, failAfterSend: 'failed to persist signal keys' })
  const first = await sender.execute('request_after_send_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }))
  assert.equal(first.result.delivery.serverAckAt, 1793620804)
  assert.equal(store.get('request_after_send_1').status, 'sent')
  const repeated = await sender.execute('request_after_send_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }))
  assert.equal(repeated.replayed, true)
  assert.equal(socket.sends.length, 1)
})

test('an error after the stanza may have left, without an ack, is ambiguous and keeps the retry blocked', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const socket = fakeSocket({ devices: { [LID]: 1 }, ack: 'none', failAfterSend: 'failed to persist signal keys' })
  await assert.rejects(sender.execute('request_after_send_2', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 10, logger })),
    (error) => error.code === 'send_interrupted' && error.ambiguous && /failed to persist signal keys/.test(error.message))
  assert.equal(store.get('request_after_send_2').status, 'pending')
  const repeated = await sender.execute('request_after_send_2', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, logger }))
  assert.equal(repeated.pending, true)
  assert.equal(socket.sends.length, 1)
})

test('a sendMessage error that cannot be placed before the send is treated as ambiguous', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const socket = fakeSocket({ devices: { [LID]: 1 }, failBeforeSend: 'encryption failed' })
  await assert.rejects(sender.execute('request_before_send_1', () => verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 10, logger })),
    (error) => error.code === 'send_interrupted' && error.ambiguous)
  assert.equal(store.get('request_before_send_1').status, 'pending')
})

test('a failed attachment upload happens before relaying and can be requested again', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  const socket = fakeSocket({ devices: { [LID]: 1 }, uploadError: 'media upload failed on all hosts' })
  const document = { document: Buffer.from('pdf'), fileName: 'resumen.pdf', mimetype: 'application/pdf' }
  await assert.rejects(sender.execute('request_upload_1', () => verifiedSend({ socket, jid: LID, content: document, logger })),
    (error) => error.code === 'upload_failed' && error.retryable && !error.ambiguous)
  assert.equal(store.get('request_upload_1'), undefined)
  assert.equal(socket.sends.length, 0)
  assert.equal(socket.ws.listenerCount('CB:ack,class:message'), 0)
})

test('the ack window starts when the attachment is actually sent, not before its upload', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 }, uploadMs: 80, ackDelayMs: 5 })
  const document = { document: Buffer.from('pdf'), fileName: 'resumen.pdf', mimetype: 'application/pdf' }
  const result = await verifiedSend({ socket, jid: LID, content: document, ackTimeoutMs: 30, logger })
  assert.equal(socket.uploads, 1)
  assert.equal(result.delivery.serverAckAt, 1793620804)
})

test('an ack that arrives while sendMessage is still finishing is not missed', async () => {
  const socket = fakeSocket({ devices: { [LID]: 1 } })
  const original = socket.sendMessage
  socket.sendMessage = async (...args) => {
    const sent = await original(...args)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return sent
  }
  const result = await verifiedSend({ socket, jid: LID, content: { text: 'Hola' }, ackTimeoutMs: 5, logger })
  assert.ok(result.delivery.serverAckAt)
})
