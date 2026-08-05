import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MAX_DELIVERY_DELAY_MS, formatScheduledMessage, ScheduledMessages } from '../src/scheduled-messages.js'

async function queueFor(context, { now = Date.parse('2026-08-01T12:00:00-03:00') } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-scheduled-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let clock = now
  return {
    queue: new ScheduledMessages(path.join(directory, 'scheduled-messages.json'), { now: () => clock }),
    filename: path.join(directory, 'scheduled-messages.json'),
    setNow: (value) => { clock = value },
  }
}

test('scheduled messages are private, preserve the requested local time, and accept macOS offsets', async (context) => {
  const { queue, filename } = await queueFor(context)
  const created = await queue.add({ target: 'Sister', jid: '123@lid', phone: '598123456', originalJid: '598123456@s.whatsapp.net', text: 'Traeme la computadora', at: '2026-08-03T21:00:00-0300' })
  const contents = await fs.readFile(filename, 'utf8')
  assert.match(contents, /Traeme la computadora/)
  assert.equal(created.dueAt, '2026-08-04T00:00:00.000Z')
  assert.match(formatScheduledMessage(created, { timeZone: 'America/Montevideo' }), /3 ago\. 2026, 21:00 \(America\/Montevideo, UTC-03:00\)/)
  assert.equal(created.requestedAt, '2026-08-03T21:00:00-0300')
})

test('scheduled dates require an explicit timezone and a bounded horizon', async (context) => {
  const { queue } = await queueFor(context)
  await assert.rejects(queue.add({ target: 'Sister', jid: '123@lid', text: 'Hola', at: '2026-08-03T21:00:00' }), /timezone/)
  await assert.rejects(queue.add({ target: 'Sister', jid: '123@lid', text: 'Hola', at: '2999-01-01T00:00:00Z' }), /one year/)
})

test('a claimed message recovered after restart becomes uncertain unless WhatsApp was confirmed', async (context) => {
  const { queue, filename, setNow } = await queueFor(context)
  const created = await queue.add({ target: 'Sister', jid: '123@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  assert.equal((await queue.claimDue()).id, created.id)

  const afterRestart = new ScheduledMessages(filename, { now: () => Date.parse('2026-08-01T12:02:30-03:00') })
  const recovered = await afterRestart.recoverInterrupted(() => undefined)
  assert.equal(recovered[0].status, 'uncertain')
  assert.equal(await afterRestart.claimDue(), null)
  assert.equal((await afterRestart.cancel(created.id)).status, 'canceled')
})

test('a confirmed send is recovered as sent after restart', async (context) => {
  const { queue, filename, setNow } = await queueFor(context)
  const created = await queue.add({ target: 'Sister', jid: '123@lid', text: 'Hola', at: '2026-08-01T12:01:00-03:00' })
  setNow(Date.parse('2026-08-01T12:02:00-03:00'))
  await queue.claimDue()
  const afterRestart = new ScheduledMessages(filename, { now: () => Date.parse('2026-08-01T12:02:30-03:00') })
  const recovered = await afterRestart.recoverInterrupted(() => ({ status: 'sent', sentAt: 1785596550, result: { key: { id: 'WA-1' } } }))
  assert.equal(recovered[0].status, 'sent')
  assert.equal(recovered[0].messageId, 'WA-1')
})

test('concurrent CLI and daemon writers retain both queue updates', async (context) => {
  const { filename } = await queueFor(context)
  const now = () => Date.parse('2026-08-01T12:00:00-03:00')
  const first = new ScheduledMessages(filename, { now })
  const second = new ScheduledMessages(filename, { now })
  await Promise.all([
    first.add({ target: 'A', jid: 'a@lid', text: 'Uno', at: '2026-08-03T21:00:00-03:00' }),
    second.add({ target: 'B', jid: 'b@lid', text: 'Dos', at: '2026-08-03T21:01:00-03:00' }),
  ])
  assert.deepEqual((await first.list()).map((message) => message.text), ['Uno', 'Dos'])
})

test('claims the earliest due message and expires stale scheduled messages', async (context) => {
  const { queue, setNow } = await queueFor(context)
  await queue.add({ target: 'Later', jid: 'later@lid', text: 'Later', at: '2026-08-01T12:10:00-03:00' })
  await queue.add({ target: 'Earlier', jid: 'earlier@lid', text: 'Earlier', at: '2026-08-01T12:05:00-03:00' })
  setNow(Date.parse('2026-08-01T12:11:00-03:00'))
  assert.equal((await queue.claimDue()).target, 'Earlier')
  await queue.uncertain((await queue.list({ all: true })).find((message) => message.target === 'Earlier').id, 'test')
  const expired = await queue.expireOverdue({ maxDelayMs: DEFAULT_MAX_DELIVERY_DELAY_MS })
  assert.equal(expired.length, 0)
  setNow(Date.parse('2026-08-01T13:20:00-03:00'))
  assert.equal((await queue.expireOverdue({ maxDelayMs: DEFAULT_MAX_DELIVERY_DELAY_MS }))[0].target, 'Later')
})

test('does not silently replace a malformed queue with an empty one', async (context) => {
  const { filename, queue } = await queueFor(context)
  await fs.writeFile(filename, JSON.stringify({ version: 2, messages: {} }))
  await assert.rejects(queue.list(), /malformed/)
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), { version: 2, messages: {} })
})
