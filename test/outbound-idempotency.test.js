import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { IdempotentSender } from '../src/outbound-idempotency.js'
import { PendingOutboundRequests } from '../src/pending-outbound-requests.js'

function retryStore() {
  const values = new Map()
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, structuredClone(value)),
    del: (key) => values.delete(key),
  }
}

test('a repeated request confirms the original WhatsApp result without sending twice', async () => {
  const sender = new IdempotentSender({ store: retryStore() })
  let sends = 0
  const first = await sender.execute('request_1234567890', async () => ({ key: { id: `WA-${++sends}` } }))
  const repeated = await sender.execute('request_1234567890', async () => ({ key: { id: `WA-${++sends}` } }))

  assert.equal(sends, 1)
  assert.equal(first.result.key.id, 'WA-1')
  assert.equal(repeated.result.key.id, 'WA-1')
  assert.equal(repeated.replayed, true)
})

test('an in-flight duplicate shares one send and a persisted pending state is never resent blindly', async () => {
  const store = retryStore()
  const sender = new IdempotentSender({ store })
  let sends = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = sender.execute('request_1234567890', async () => {
    sends += 1
    await gate
    return { key: { id: 'WA-1' } }
  })
  const duplicate = sender.execute('request_1234567890', async () => {
    sends += 1
    return { key: { id: 'WA-2' } }
  })
  release()
  await Promise.all([first, duplicate])
  assert.equal(sends, 1)

  store.set('uncertain_1234567890', { status: 'pending', startedAt: 1 })
  const afterRestart = new IdempotentSender({ store })
  const uncertain = await afterRestart.execute('uncertain_1234567890', async () => ({ key: { id: 'must-not-send' } }))
  assert.deepEqual(uncertain, { pending: true, requestId: 'uncertain_1234567890' })
})

test('the CLI keeps only a private fingerprint while an outbound result is uncertain', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-outbound-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'pending-outbound-requests.json')
  const requests = new PendingOutboundRequests(filename)
  const operation = { kind: 'document', to: '59812345678', caption: 'resumen confidencial', file: { path: '/tmp/recap.pdf', size: 20, modifiedAt: 1 } }
  const first = await requests.claim(operation)
  const repeated = await requests.claim(operation)

  assert.equal(first.requestId, repeated.requestId)
  const contents = await fs.readFile(filename, 'utf8')
  assert.doesNotMatch(contents, /resumen confidencial|59812345678|recap\.pdf/)
  await requests.complete(first.fingerprint)
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), {})
})
