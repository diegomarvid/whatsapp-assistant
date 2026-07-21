import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_HISTORY_POLICY, historyPolicyForDays, loadHistoryPolicy, saveHistoryPolicy } from '../src/history-policy.js'

test('uses a bounded recent default and asks WhatsApp for extended history only when requested', () => {
  assert.deepEqual(DEFAULT_HISTORY_POLICY, { version: 1, retentionDays: 7, syncFullHistory: false, maxMessages: 10000 })
  assert.deepEqual(historyPolicyForDays(365), { version: 1, retentionDays: 365, syncFullHistory: true, maxMessages: null })
  assert.throws(() => historyPolicyForDays(0), /between 1 and 3650/)
})

test('persists an explicit history policy privately', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-history-policy-'))
  try {
    assert.deepEqual(await loadHistoryPolicy(directory), DEFAULT_HISTORY_POLICY)
    await saveHistoryPolicy(directory, historyPolicyForDays(30))
    assert.deepEqual(await loadHistoryPolicy(directory), { version: 1, retentionDays: 30, syncFullHistory: true, maxMessages: null })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
