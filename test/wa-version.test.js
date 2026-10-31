import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWaVersion } from '../src/wa-version.js'

const BUNDLED = [2, 3000, 1]

test('the live WhatsApp Web version wins over the Baileys repository file', async () => {
  const result = await resolveWaVersion({
    fetchWeb: async () => ({ version: [2, 3000, 1052536159], isLatest: true }),
    fetchBaileys: async () => ({ version: [2, 3000, 1043857760], isLatest: true }),
    bundled: BUNDLED,
  })
  assert.deepEqual(result.version, [2, 3000, 1052536159])
  assert.equal(result.source, 'web.whatsapp.com')
})

test('an unconfirmed or failing web lookup falls back to the repository, then to the bundled version', async () => {
  const fromRepository = await resolveWaVersion({
    fetchWeb: async () => ({ version: BUNDLED, isLatest: false, error: new Error('offline') }),
    fetchBaileys: async () => ({ version: [2, 3000, 7], isLatest: true }),
    bundled: BUNDLED,
  })
  assert.deepEqual(fromRepository.version, [2, 3000, 7])
  assert.equal(fromRepository.source, 'baileys-repository')
  assert.deepEqual(fromRepository.failures, [{ source: 'web.whatsapp.com', error: 'offline' }])

  const bundled = await resolveWaVersion({
    fetchWeb: async () => { throw new Error('dns') },
    fetchBaileys: async () => ({ version: 'garbage', isLatest: true }),
    bundled: BUNDLED,
  })
  assert.deepEqual(bundled.version, BUNDLED)
  assert.equal(bundled.source, 'bundled')
  assert.equal(bundled.failures.length, 2)
})

test('a hanging lookup cannot block the connection', async () => {
  const result = await resolveWaVersion({
    fetchWeb: () => new Promise(() => {}),
    fetchBaileys: async () => ({ version: [2, 3000, 9], isLatest: true }),
    bundled: BUNDLED,
    timeoutMs: 20,
  })
  assert.equal(result.source, 'baileys-repository')
  assert.equal(result.failures[0].error, 'timeout')
})
