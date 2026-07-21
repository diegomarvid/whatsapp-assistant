import assert from 'node:assert/strict'
import test from 'node:test'
import { coverageForChat } from '../src/chat-coverage.js'

const now = 1_784_000_000
const connectedAt = now - 600

function coverage(overrides = {}) {
  return coverageForChat({
    chat: { jid: '1@lid', remoteLastTimestamp: now - 3600, lastObservedLiveAt: null, lastObservedHistoryAt: null },
    messages: [{ jid: '1@lid', id: 'a', timestamp: now - 3600 }],
    connection: 'open',
    sync: { lastConnectedAt: connectedAt, ingestionHealthy: true },
    ...overrides,
  })
}

test('a chat observed live after the current connection is fresh', () => {
  const report = coverage({ chat: { jid: '1@lid', remoteLastTimestamp: now - 3600, lastObservedLiveAt: connectedAt + 10 } })
  assert.equal(report.fresh, true)
  assert.deepEqual(report.reasons, [])
})

test('a quiet chat is fresh once WhatsApp drained the offline queue of this connection', () => {
  const stale = coverage()
  assert.equal(stale.fresh, false)
  assert.deepEqual(stale.reasons, ['chat_not_observed_after_connection'])

  const drained = coverage({ sync: { lastConnectedAt: connectedAt, ingestionHealthy: true, pendingNotificationsFlushedAt: connectedAt + 5 } })
  assert.equal(drained.fresh, true)
  assert.deepEqual(drained.reasons, [])
  assert.equal(drained.offlineQueueFlushedAt, connectedAt + 5)
})

test('an offline flush from a previous connection does not count', () => {
  const report = coverage({ sync: { lastConnectedAt: connectedAt, ingestionHealthy: true, pendingNotificationsFlushedAt: connectedAt - 100 } })
  assert.equal(report.fresh, false)
  assert.deepEqual(report.reasons, ['chat_not_observed_after_connection'])
})

test('a drained queue never overrides a remote cursor ahead of the local cache', () => {
  const report = coverage({
    chat: { jid: '1@lid', remoteLastTimestamp: now - 60 },
    sync: { lastConnectedAt: connectedAt, ingestionHealthy: true, pendingNotificationsFlushedAt: connectedAt + 5 },
  })
  assert.equal(report.fresh, false)
  assert.equal(report.status, 'stale')
  assert.deepEqual(report.reasons, ['remote_chat_ahead_of_cache'])
})

test('a disconnected or unhealthy bridge is never fresh', () => {
  const disconnected = coverage({ connection: 'disconnected', sync: { lastConnectedAt: connectedAt, ingestionHealthy: true, pendingNotificationsFlushedAt: connectedAt + 5 } })
  assert.equal(disconnected.fresh, false)
  assert.ok(disconnected.reasons.includes('bridge_not_connected'))

  const unhealthy = coverage({ sync: { lastConnectedAt: connectedAt, ingestionHealthy: false, pendingNotificationsFlushedAt: connectedAt + 5 } })
  assert.equal(unhealthy.fresh, false)
  assert.ok(unhealthy.reasons.includes('ingestion_unhealthy'))
})
