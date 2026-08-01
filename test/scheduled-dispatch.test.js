import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dispatchScheduledMessages } from '../src/scheduled-dispatch.js'
import { ScheduledMessages } from '../src/scheduled-messages.js'

async function dueQueue(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-dispatch-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-08-01T12:00:00-03:00')
  const queue = new ScheduledMessages(path.join(directory, 'scheduled-messages.json'), { now: () => now })
  const message = await queue.add({ target: 'Sister', jid: 'old@lid', phone: '598123456', originalJid: '598123456@s.whatsapp.net', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  now = Date.parse('2026-08-01T12:05:00-03:00')
  return { queue, message }
}

const logger = { info() {}, error() {} }

test('an ambiguous send error is retained as uncertain and never retried automatically', async (context) => {
  const { queue } = await dueQueue(context)
  let sends = 0
  const first = await dispatchScheduledMessages({
    queue, canSend: () => true, resolveJid: async () => 'new@lid',
    send: async () => { sends += 1; throw new Error('Timed Out') }, logger,
  })
  assert.equal(first.uncertain.length, 1)
  await dispatchScheduledMessages({ queue, canSend: () => true, resolveJid: async () => 'new@lid', send: async () => { sends += 1 }, logger })
  assert.equal(sends, 1)
  assert.equal((await queue.list())[0].status, 'uncertain')
})

test('dispatch resolves the stored phone JID immediately before delivery', async (context) => {
  const { queue, message } = await dueQueue(context)
  let resolved = null
  let sent = null
  await dispatchScheduledMessages({
    queue, canSend: () => true,
    resolveJid: async (jid) => { resolved = jid; return 'new@lid' },
    send: async (entry, jid) => { sent = { entry, jid }; return { sent: true, id: 'WA-1' } }, logger,
  })
  assert.equal(resolved, '598123456@s.whatsapp.net')
  assert.equal(sent.jid, 'new@lid')
  assert.equal(sent.entry.id, message.id)
  assert.equal((await queue.list({ all: true }))[0].status, 'sent')
})

test('a disconnected bridge does not claim deliverable messages', async (context) => {
  const { queue } = await dueQueue(context)
  const result = await dispatchScheduledMessages({ queue, canSend: () => false, resolveJid: async () => null, send: async () => null, logger })
  assert.equal(result.sent.length, 0)
  assert.equal((await queue.list())[0].status, 'scheduled')
})
