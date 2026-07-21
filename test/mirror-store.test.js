import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MirrorStore } from '../src/mirror-store.js'

test('persists recent messages atomically without retaining older history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'))
  const filename = path.join(directory, 'mirror.sqlite')
  const store = new MirrorStore(filename, { retentionDays: 7 })
  const now = 1_000_000
  store.persist({
    messages: [
      { jid: 'chat@lid', id: 'old', timestamp: now - (8 * 86400), text: 'old' },
      { jid: 'chat@lid', id: 'latest', timestamp: now - 1, text: 'latest' },
    ],
    chats: { 'chat@lid': { jid: 'chat@lid', lastTimestamp: now - 1 } },
    contacts: { 'chat@lid': { id: 'chat@lid', name: 'Flor' } },
    sync: { observerStartedAt: now - 10 },
  }, now)
  store.close()

  const reopened = new MirrorStore(filename, { retentionDays: 7 })
  assert.deepEqual(reopened.load(), {
    messages: [{ jid: 'chat@lid', id: 'latest', timestamp: now - 1, text: 'latest' }],
    chats: { 'chat@lid': { jid: 'chat@lid', lastTimestamp: now - 1 } },
    contacts: { 'chat@lid': { id: 'chat@lid', name: 'Flor' } },
    sync: { observerStartedAt: now - 10 },
  })
  reopened.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('updates an existing event by chat and message identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'))
  const filename = path.join(directory, 'mirror.sqlite')
  const store = new MirrorStore(filename)
  const state = { messages: [{ jid: 'chat@lid', id: 'one', timestamp: 100, text: 'first' }], chats: {}, contacts: {}, sync: {} }
  store.persist(state, 200)
  state.messages[0] = { ...state.messages[0], text: 'updated' }
  store.persist(state, 200)
  assert.equal(store.load().messages[0].text, 'updated')
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
