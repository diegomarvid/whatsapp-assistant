import test from 'node:test'
import assert from 'node:assert/strict'
import { processEventBatch } from '../src/event-batch.js'

test('a failing handler does not drop the messages carried in the same batch', async () => {
  const seen = []
  const failures = []
  await processEventBatch(
    { 'group-participants.update': { participants: 'not-an-array' }, 'messages.upsert': { messages: ['m1'] } },
    [
      ['creds.update', async () => seen.push('creds')],
      ['group-participants.update', async () => { throw new TypeError('(updates || []) is not iterable') }],
      ['messages.upsert', async ({ messages }) => seen.push(...messages)],
    ],
    async (name, error) => failures.push([name, error.message]),
  )
  assert.deepEqual(seen, ['m1'])
  assert.deepEqual(failures, [['group-participants.update', '(updates || []) is not iterable']])
})

test('handlers run in declaration order and only for events present in the batch', async () => {
  const order = []
  await processEventBatch(
    { 'messages.upsert': {}, 'connection.update': {}, call: [] },
    [
      ['creds.update', async () => order.push('creds')],
      ['connection.update', async () => order.push('connection')],
      ['messages.upsert', async () => order.push('upsert')],
      ['call', async () => order.push('call')],
    ],
    async () => assert.fail('no handler failed'),
  )
  assert.deepEqual(order, ['connection', 'upsert', 'call'])
})
