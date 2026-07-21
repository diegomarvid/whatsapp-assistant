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
    groupEvents: [],
    sync: { observerStartedAt: now - 10 },
  }, now)
  store.close()

  const reopened = new MirrorStore(filename, { retentionDays: 7 })
  assert.deepEqual(reopened.load(), {
    messages: [{ jid: 'chat@lid', id: 'latest', timestamp: now - 1, text: 'latest' }],
    chats: { 'chat@lid': { jid: 'chat@lid', lastTimestamp: now - 1 } },
    contacts: { 'chat@lid': { id: 'chat@lid', name: 'Flor' } },
    groupEvents: [],
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

test('keeps a recent raw message envelope available for Baileys retries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'))
  const filename = path.join(directory, 'mirror.sqlite')
  const store = new MirrorStore(filename, { retentionDays: 7 })
  const payload = Buffer.from('serialized-message')
  store.saveMessageContent({ jid: 'chat@lid', id: 'one', timestamp: 100, payload })
  assert.deepEqual(store.loadMessageContent({ jid: 'chat@lid', id: 'one' }), payload)
  store.persist({ messages: [], chats: {}, contacts: {}, sync: {} }, 100 + (8 * 86400))
  assert.equal(store.loadMessageContent({ jid: 'chat@lid', id: 'one' }), null)
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('keeps a poll decryption secret private and prunes it with recent state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'))
  const filename = path.join(directory, 'mirror.sqlite')
  const store = new MirrorStore(filename, { retentionDays: 7 })
  const secret = Buffer.from('poll-secret')
  store.savePollSecret({ jid: 'group@g.us', id: 'poll-1', timestamp: 100, secret })
  assert.deepEqual(store.loadPollSecret({ jid: 'group@g.us', id: 'poll-1' }), secret)
  store.persist({ messages: [], chats: {}, contacts: {}, groupEvents: [], sync: {} }, 100 + (8 * 86400))
  assert.equal(store.loadPollSecret({ jid: 'group@g.us', id: 'poll-1' }), null)
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('persists retry counters across a store reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'))
  const filename = path.join(directory, 'mirror.sqlite')
  const store = new MirrorStore(filename)
  const retryCache = store.createRetryCache('message-retry', { ttlSeconds: 3600 })
  retryCache.set('message:participant', 2)
  store.close()

  const reopened = new MirrorStore(filename)
  const reopenedRetryCache = reopened.createRetryCache('message-retry', { ttlSeconds: 3600 })
  assert.equal(reopenedRetryCache.get('message:participant'), 2)
  reopenedRetryCache.del('message:participant')
  assert.equal(reopenedRetryCache.get('message:participant'), undefined)
  reopened.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
