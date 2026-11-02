import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dispatchScheduledMessages, scheduledRecipient } from '../src/scheduled-dispatch.js'
import { describeScheduledMessage, formatScheduledMessage, RECEIPT_STATUS, ScheduledMessages } from '../src/scheduled-messages.js'
import { verifiedSend } from '../src/verified-send.js'
import { fakeSocket, silentLogger as logger } from './helpers/fake-socket.js'

async function tempQueue(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-dispatch-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-08-01T12:00:00-03:00')
  const filename = path.join(directory, 'scheduled-messages.json')
  return { filename, queue: new ScheduledMessages(filename, { now: () => now }), setNow: (value) => { now = value }, now: () => now }
}

async function dueQueue(context) {
  const state = await tempQueue(context)
  const message = await state.queue.add({ target: 'Sister', jid: 'old@lid', phone: '598123456', originalJid: '598123456@s.whatsapp.net', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  state.setNow(Date.parse('2026-08-01T12:05:00-03:00'))
  return { ...state, message }
}

// The bridge's production composition, with a simulated Baileys socket.
function bridgeSend(socket, { ackTimeoutMs } = {}) {
  return async (message, jid) => {
    const result = await verifiedSend({ socket, jid, content: { text: message.text }, ackTimeoutMs, logger })
    return { sent: true, id: result.key.id, delivery: result.delivery }
  }
}

test('an ambiguous send error is retained as uncertain and never retried automatically', async (context) => {
  const { queue } = await dueQueue(context)
  let sends = 0
  const alerts = []
  const first = await dispatchScheduledMessages({
    queue, canSend: () => true, resolveRecipient: async () => 'new@lid', notify: (message) => alerts.push(message),
    send: async () => { sends += 1; throw new Error('Timed Out') }, logger,
  })
  assert.equal(first.uncertain.length, 1)
  await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async () => 'new@lid', send: async () => { sends += 1 }, logger })
  assert.equal(sends, 1)
  assert.equal((await queue.list())[0].status, 'uncertain')
  assert.deepEqual(alerts.map((message) => message.status), ['uncertain'])
})

test('dispatch resolves the stored phone JID immediately before delivery', async (context) => {
  const { queue, message } = await dueQueue(context)
  let resolved = null
  let sent = null
  await dispatchScheduledMessages({
    queue, canSend: () => true,
    resolveRecipient: async (entry) => { resolved = scheduledRecipient(entry); return 'new@lid' },
    send: async (entry, jid) => { sent = { entry, jid }; return { sent: true, id: 'WA-1' } }, logger,
  })
  assert.deepEqual(resolved, { phoneJid: '598123456@s.whatsapp.net' })
  assert.equal(sent.jid, 'new@lid')
  assert.equal(sent.entry.id, message.id)
  assert.equal((await queue.list({ all: true }))[0].status, 'sent')
})

test('a disconnected bridge does not claim deliverable messages', async (context) => {
  const { queue } = await dueQueue(context)
  const result = await dispatchScheduledMessages({ queue, canSend: () => false, resolveRecipient: async () => null, send: async () => null, logger })
  assert.equal(result.sent.length, 0)
  assert.equal((await queue.list())[0].status, 'scheduled')
})

// Regression for 2026-11-02: a message scheduled to a LID target stored the
// LID's digits as a phone and <digits>@s.whatsapp.net as its identity. Dispatch
// resolved that non-existent number, Baileys "sent" it to zero devices without
// an error, and the queue said sent.
test('the LID-as-phone incident: the queue repairs the identity and delivers to the LID', async (context) => {
  const { queue, filename, setNow } = await tempQueue(context)
  await fs.writeFile(filename, JSON.stringify({ version: 2, messages: [{
    id: 'incident', requestId: 'incidentrequest1', target: '100000000000001@lid', jid: '100000000000001@lid',
    phone: '100000000000001', originalJid: '100000000000001@s.whatsapp.net',
    dueAt: '2026-08-01T15:01:00.000Z', requestedAt: '2026-08-01T12:01:00-03:00', createdAt: '2026-08-01T14:00:00.000Z',
    status: 'scheduled', attempts: 0, text: 'Hola',
  }] }))
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const socket = fakeSocket({ devices: { '100000000000001@lid': 1 } })
  const result = await dispatchScheduledMessages({
    queue, canSend: () => true, resolveRecipient: async (message) => scheduledRecipient(message).jid,
    send: bridgeSend(socket), logger,
  })
  assert.equal(result.sent.length, 1)
  assert.deepEqual(socket.sends.map((send) => send.jid), ['100000000000001@lid'])
  const [entry] = await queue.list({ all: true })
  assert.equal(entry.originalJid, null)
  assert.equal(entry.deliveredJid, '100000000000001@lid')
  assert.equal(entry.recipientDevices, 1)
  assert.ok(entry.serverAckAt)
})

test('a recipient with no device is never marked sent: bounded retries, then failed and alerted', async (context) => {
  const { queue, setNow, now } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@s.whatsapp.net', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  const devices = {}
  const socket = fakeSocket({ devices })
  const alerts = []
  const dispatch = () => dispatchScheduledMessages({
    queue, canSend: () => true, resolveRecipient: async (message) => message.jid, notify: (message) => alerts.push(message),
    send: bridgeSend(socket), logger, retryDelaysMs: [60_000, 120_000],
  })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const first = await dispatch()
  assert.equal(first.retrying.length, 1)
  assert.equal(first.sent.length, 0)
  assert.equal((await queue.list())[0].status, 'scheduled')
  assert.match(formatScheduledMessage((await queue.list())[0]), /— retrying —/)

  assert.equal((await dispatch()).retrying.length, 0, 'not retried before its backoff')
  setNow(now() + 60_000)
  assert.equal((await dispatch()).retrying.length, 1)
  setNow(now() + 120_000)
  const last = await dispatch()
  assert.equal(last.failed.length, 1)
  const [entry] = await queue.list()
  assert.equal(entry.status, 'failed')
  assert.equal(entry.attempts, 3)
  assert.equal(entry.failureCode, 'no_recipient_devices')
  assert.match(entry.lastError, /no device/)
  assert.equal(socket.sends.length, 0, 'nothing ever left the device')
  assert.deepEqual(alerts.map((message) => message.id), [entry.id], 'one alert, on the final failure')
})

test('a LID without devices is delivered to its mapped phone equivalent', async (context) => {
  const { queue, setNow } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const socket = fakeSocket({ devices: { '59800000002@s.whatsapp.net': 1 }, mapping: { '100000000000001@lid': '59800000002:0@s.whatsapp.net' } })
  const result = await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async (message) => message.jid, send: bridgeSend(socket), logger })
  assert.equal(result.sent[0].deliveredJid, '59800000002@s.whatsapp.net')
})

test('a send WhatsApp rejects is failed and not retried', async (context) => {
  const { queue, setNow } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const socket = fakeSocket({ devices: { '100000000000001@lid': 1 }, ack: 'error' })
  const alerts = []
  const result = await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async (message) => message.jid, send: bridgeSend(socket), notify: (message) => alerts.push(message), logger })
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].failureCode, 'server_rejected')
  assert.equal(alerts.length, 1)
  await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async (message) => message.jid, send: bridgeSend(socket), logger })
  assert.equal(socket.sends.length, 1)
})

test('a send without server ack is uncertain, alerted and not retried', async (context) => {
  const { queue, setNow } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const socket = fakeSocket({ devices: { '100000000000001@lid': 1 }, ack: 'none' })
  const alerts = []
  const result = await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async (message) => message.jid, send: bridgeSend(socket, { ackTimeoutMs: 10 }), notify: (message) => alerts.push(message), logger })
  assert.equal(result.uncertain.length, 1)
  assert.match(result.uncertain[0].lastError, /did not acknowledge/)
  assert.equal(alerts.length, 1)
})

test('an unresolvable recipient is retried and never sent', async (context) => {
  const { queue, setNow } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  let sends = 0
  const result = await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async () => null, send: async () => { sends += 1 }, logger })
  assert.equal(result.retrying[0].failureCode, 'recipient_unresolved')
  assert.equal(sends, 0)
})

test('a failing alert channel never interrupts dispatch', async (context) => {
  const { queue } = await dueQueue(context)
  const result = await dispatchScheduledMessages({
    queue, canSend: () => true, resolveRecipient: async () => 'new@lid', send: async () => { throw new Error('Timed Out') },
    notify: async () => { throw new Error('alert channel down') }, logger,
  })
  assert.equal(result.uncertain.length, 1)
})

test('an alias is resolved again at send time; a LID or group is never re-encoded as a phone', () => {
  const aliases = { ana: { phone: '+598 00 000 003', jid: '59800000099@s.whatsapp.net' } }
  assert.deepEqual(scheduledRecipient({ alias: 'ana', jid: 'old@lid', originalJid: '59800000099@s.whatsapp.net' }, aliases), { phoneJid: '59800000003@s.whatsapp.net' })
  assert.deepEqual(scheduledRecipient({ alias: 'gone', jid: 'old@lid', originalJid: '59800000099@s.whatsapp.net' }, aliases), { phoneJid: '59800000099@s.whatsapp.net' })
  assert.deepEqual(scheduledRecipient({ jid: '100000000000001@lid', originalJid: null }), { jid: '100000000000001@lid' })
  assert.deepEqual(scheduledRecipient({ jid: '120363000000000001@g.us', originalJid: '120363000000000001@s.whatsapp.net' }), { jid: '120363000000000001@g.us' })
})

test('delivery and read receipts become visible in list and show', async (context) => {
  const { queue, setNow } = await tempQueue(context)
  await queue.add({ target: 'Ana', jid: '100000000000001@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  const socket = fakeSocket({ devices: { '100000000000001@lid': 2 } })
  const { sent: [entry] } = await dispatchScheduledMessages({ queue, canSend: () => true, resolveRecipient: async (message) => message.jid, send: bridgeSend(socket), logger })
  assert.match(formatScheduledMessage(entry), /— sent —/)
  assert.match(describeScheduledMessage(entry, { timeZone: 'America/Montevideo' }), /Servidor WhatsApp: ack .*\nEntregado: sin receipt de entrega todavía/)

  await queue.recordReceipt(entry.messageId, RECEIPT_STATUS.DELIVERY_ACK, 1785596600)
  let [current] = await queue.list({ all: true })
  assert.match(formatScheduledMessage(current), /— delivered —/)
  await queue.recordReceipt(entry.messageId, RECEIPT_STATUS.READ, 1785596700)
  await queue.recordReceipt(entry.messageId, RECEIPT_STATUS.DELIVERY_ACK, 1785596800)
  ;[current] = await queue.list({ all: true })
  assert.match(formatScheduledMessage(current), /— read —/)
  assert.equal(current.deliveredAt, new Date(1785596600 * 1000).toISOString(), 'a late receipt never moves a recorded time')
  const shown = describeScheduledMessage(current, { timeZone: 'America/Montevideo' })
  assert.match(shown, /Destino usado: 100000000000001@lid \(2 dispositivos\)/)
  assert.match(shown, /Leído: /)
})

test('an entry sent before verification is shown as unconfirmed', () => {
  const legacy = { id: 'x', status: 'sent', dueAt: '2026-08-01T15:00:00.000Z', target: 'Ana', text: 'Hola', messageId: 'WA-1' }
  assert.match(formatScheduledMessage(legacy), /— sent \(unconfirmed\) —/)
  assert.match(describeScheduledMessage(legacy), /sin ack registrado/)
})
