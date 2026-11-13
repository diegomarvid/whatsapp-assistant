import assert from 'node:assert/strict'
import test from 'node:test'
import { Boom } from '@hapi/boom'
import {
  OFFLINE_FLUSH_GRACE_SECONDS,
  assessLinkHealth,
  linkAlertMessage,
  linkClosed,
  linkOpened,
  offlineQueueFlushed,
  tickLinkAlert,
} from '../src/link-health.js'

const MINUTE = 60
const HOUR = 60 * MINUTE
// 2026-11-12 17:01:13 -03:00, the last offline flush before the incident.
const FLUSHED = 1794513673

// The stream:error the server sent every ~50 minutes during the incident.
const ackStreamError = (id = 'A56DE9D49C61A40D37CD96954912CD62', type = 'media') => new Boom('Stream Errored (ack)', {
  statusCode: 500,
  data: { tag: 'ack', attrs: { class: 'status', type, id } },
})

// Replays the incident: connected and ingesting until 17:51, then a reconnect
// every ~50 minutes in which WhatsApp never finished the offline queue.
function incidentSync() {
  let sync = { observerStartedAt: FLUSHED - 60 }
  sync = { ...sync, ...linkOpened(sync, FLUSHED - 2) }
  sync = { ...sync, ...offlineQueueFlushed(sync, FLUSHED) }
  let now = FLUSHED + 50 * MINUTE
  sync = { ...sync, ...linkClosed(sync, now, { statusCode: 500, error: ackStreamError('AC820019F031A29AE5F1E507685D1BAB') }) }
  for (let cycle = 0; cycle < 6; cycle++) {
    now += 3
    sync = { ...sync, ...linkOpened(sync, now) }
    now += 50 * MINUTE
    sync = { ...sync, ...linkClosed(sync, now, { statusCode: 500, error: ackStreamError() }) }
  }
  now += 3
  sync = { ...sync, ...linkOpened(sync, now) }
  return { sync, now }
}

test('the incident is unhealthy even though the socket is open and ingestion never threw', () => {
  const { sync, now } = incidentSync()
  // A minute after the latest reconnect: per-connection checks would still say "starting".
  const health = assessLinkHealth({ connection: 'open', sync: { ...sync, ingestionHealthy: true }, now: now + MINUTE })
  assert.equal(health.status, 'unhealthy')
  assert.equal(health.healthy, false)
  assert.deepEqual(health.reasons, ['offline_queue_not_flushed', 'unacked_stanza_stream_errors'])
  assert.equal(health.offlineQueue.pendingSince, FLUSHED + 50 * MINUTE + 3)
  assert.ok(health.offlineQueue.unflushedConnectedSeconds >= 6 * 50 * MINUTE)
  assert.equal(health.streamErrors.unackedLast3h, 4, "closes 63 s, 51, 101 and 151 min ago")
  assert.deepEqual(health.streamErrors.lastUnacked, { at: sync.recentDisconnects.at(-1).at, statusCode: 500, unackedClass: 'status', unackedType: 'media' })
})

test('a normal reconnect is pending while WhatsApp flushes the queue, then healthy', () => {
  let sync = {}
  sync = { ...sync, ...linkOpened(sync, 1000) }
  assert.equal(assessLinkHealth({ connection: 'open', sync, now: 1010 }).status, 'pending')
  sync = { ...sync, ...offlineQueueFlushed(sync, 1012) }
  const health = assessLinkHealth({ connection: 'open', sync, now: 1020 })
  assert.equal(health.status, 'healthy')
  assert.equal(health.healthy, true)
  assert.deepEqual(health.reasons, [])
  assert.equal(health.offlineQueue.pendingSince, null)
})

test('the offline queue is reported only after the grace period of connected time', () => {
  let sync = linkOpened({}, 1000)
  assert.equal(assessLinkHealth({ connection: 'open', sync, now: 1000 + OFFLINE_FLUSH_GRACE_SECONDS - 1 }).status, 'pending')
  assert.deepEqual(assessLinkHealth({ connection: 'open', sync, now: 1000 + OFFLINE_FLUSH_GRACE_SECONDS }).reasons, ['offline_queue_not_flushed'])
})

test('time asleep does not count: a Mac that slept before the flush is not alarmed on wake', () => {
  let sync = linkOpened({}, 1000)
  // The lid closed 20 s after connecting; the close is seen on wake, 8 h later.
  sync = { ...sync, ...linkClosed(sync, 1020, { statusCode: 428, error: new Boom('Connection Closed', { statusCode: 428 }) }) }
  sync = { ...sync, ...linkOpened(sync, 1000 + 8 * HOUR) }
  const health = assessLinkHealth({ connection: 'open', sync, now: 1000 + 8 * HOUR + 30 })
  assert.equal(health.status, 'pending')
  assert.equal(health.offlineQueue.pendingSince, 1000, 'the display still says since when the queue is pending')
})

test('a flush clears the stall accounting for good', () => {
  const { sync: stalled, now } = incidentSync()
  const sync = { ...stalled, ...offlineQueueFlushed(stalled, now + 5) }
  assert.equal(sync.offlineQueuePendingSince, null)
  assert.equal(sync.offlineQueueUnflushedSeconds, 0)
  // The ack loop is still recent: healthy only after surviving the server's ack timeout.
  assert.deepEqual(assessLinkHealth({ connection: 'open', sync, now: now + 10 * MINUTE }).reasons, ['unacked_stanza_stream_errors'])
  const health = assessLinkHealth({ connection: 'open', sync, now: now + 56 * MINUTE })
  assert.equal(health.status, 'healthy')
})

test('one stream error naming an ack is shown but is not a loop', () => {
  let sync = linkOpened({}, 1000)
  sync = { ...sync, ...offlineQueueFlushed(sync, 1001) }
  sync = { ...sync, ...linkClosed(sync, 1000 + 50 * MINUTE, { statusCode: 500, error: ackStreamError() }) }
  sync = { ...sync, ...linkOpened(sync, 1000 + 50 * MINUTE + 3) }
  sync = { ...sync, ...offlineQueueFlushed(sync, 1000 + 50 * MINUTE + 4) }
  const health = assessLinkHealth({ connection: 'open', sync, now: 1000 + 51 * MINUTE })
  assert.equal(health.status, 'healthy')
  assert.equal(health.streamErrors.unackedLast3h, 1)
})

test('other disconnects are counted but never named as an unacked stanza', () => {
  let sync = linkOpened({}, 1000)
  sync = { ...sync, ...linkClosed(sync, 2000, { statusCode: 503, error: new Boom('Stream Errored (unknown)', { statusCode: 503, data: { tag: 'stream:error', attrs: { code: '503' } } }) }) }
  sync = { ...sync, ...linkClosed(sync, 2001, { statusCode: 428, error: new Boom('Connection Closed', { statusCode: 428 }) }) }
  assert.deepEqual(sync.recentDisconnects, [{ at: 2000, statusCode: 503 }, { at: 2001, statusCode: 428 }])
  // Only the first close after an open counts as connected-but-unflushed time.
  assert.equal(sync.offlineQueueUnflushedSeconds, 1000)
})

test('a disconnected bridge is unhealthy after the grace period, a logged-out one at once', () => {
  let sync = linkOpened({}, 1000)
  sync = { ...sync, ...offlineQueueFlushed(sync, 1001) }
  sync = { ...sync, ...linkClosed(sync, 2000, { statusCode: 408, error: new Boom('timed out', { statusCode: 408 }) }) }
  assert.equal(assessLinkHealth({ connection: 'disconnected', sync, now: 2060 }).status, 'pending')
  assert.deepEqual(assessLinkHealth({ connection: 'disconnected', sync, now: 2000 + OFFLINE_FLUSH_GRACE_SECONDS }).reasons, ['bridge_not_connected'])
  assert.deepEqual(assessLinkHealth({ connection: 'logged_out', sync, now: 2001 }).reasons, ['bridge_not_connected'])
})

test('the disconnect log keeps a bounded 24 h window', () => {
  let sync = {}
  for (let index = 0; index < 80; index++) sync = { ...sync, ...linkClosed(sync, 1000 + index * MINUTE, { statusCode: 428 }) }
  assert.equal(sync.recentDisconnects.length, 50)
  sync = { ...sync, ...linkClosed(sync, 1000 + 80 * MINUTE + 25 * HOUR, { statusCode: 428 }) }
  assert.equal(sync.recentDisconnects.length, 1)
})

test('alerts once when the link breaks and once when it recovers, never while it stays broken', async () => {
  const sent = []
  const notify = async (alert) => { sent.push(alert) }
  const unhealthy = { status: 'unhealthy', reasons: ['offline_queue_not_flushed'], offlineQueue: { pendingSince: 1000 }, streamErrors: { unackedLast3h: 0 } }
  const pending = { status: 'pending', reasons: [], offlineQueue: { pendingSince: 1000 }, streamErrors: { unackedLast3h: 0 } }
  const healthy = { status: 'healthy', reasons: [], offlineQueue: { pendingSince: null }, streamErrors: { unackedLast3h: 0 } }
  let state = await tickLinkAlert({ state: undefined, health: healthy, now: 900, notify })
  assert.equal(sent.length, 0)
  state = await tickLinkAlert({ state, health: unhealthy, now: 2000, notify })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.kind, 'link_health')
  assert.equal(sent[0].payload.state, 'opened')
  // Reconnects put the link back in "pending" for a moment: no recovery, no repeat.
  for (const [health, now] of [[unhealthy, 2060], [pending, 2120], [unhealthy, 2180], [pending, 5000]]) state = await tickLinkAlert({ state, health, now, notify })
  assert.equal(sent.length, 1)
  state = await tickLinkAlert({ state, health: healthy, now: 9000, notify })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].payload.state, 'recovered')
  assert.equal(sent[1].payload.openedAt, 2000)
  state = await tickLinkAlert({ state, health: healthy, now: 9060, notify })
  assert.equal(sent.length, 2)
  assert.equal(state.open, false)
})

test('a failed alert is retried with backoff, and a recovery is not announced for an alert nobody got', async () => {
  const unhealthy = { status: 'unhealthy', reasons: ['offline_queue_not_flushed'], offlineQueue: { pendingSince: 1000 }, streamErrors: { unackedLast3h: 0 } }
  const healthy = { status: 'healthy', reasons: [], offlineQueue: { pendingSince: null }, streamErrors: { unackedLast3h: 0 } }
  let attempts = 0
  const failing = async () => { attempts++; throw new Error('telegram unreachable') }
  let state = await tickLinkAlert({ state: {}, health: unhealthy, now: 2000, notify: failing })
  assert.equal(attempts, 1)
  assert.equal(state.lastAlertError, 'telegram unreachable')
  state = await tickLinkAlert({ state, health: unhealthy, now: 2060, notify: failing })
  assert.equal(attempts, 1, 'no retry inside the backoff window')
  state = await tickLinkAlert({ state, health: unhealthy, now: 2000 + 15 * MINUTE, notify: failing })
  assert.equal(attempts, 2)
  const sent = []
  state = await tickLinkAlert({ state, health: healthy, now: 9000, notify: async (alert) => { sent.push(alert) } })
  assert.deepEqual(sent, [])
  assert.equal(state.open, false)
})

test('alert text names the problem and the next step without private data', () => {
  const opened = linkAlertMessage('opened', { openedAt: 1794538007 }, {
    reasons: ['offline_queue_not_flushed', 'unacked_stanza_stream_errors'],
    offlineQueue: { pendingSince: 1794516679 },
    streamErrors: { unackedLast3h: 3, lastUnacked: { unackedClass: 'status' } },
  }, 1794538007)
  assert.match(opened.summary, /^WhatsApp Assistant: /)
  assert.match(opened.summary, /cola offline/)
  assert.match(opened.summary, /17:51/)
  assert.match(opened.summary, /wa doctor/)
  assert.equal(opened.payload.version, 1)
  assert.deepEqual(opened.payload.reasons, ['offline_queue_not_flushed', 'unacked_stanza_stream_errors'])
  const recovered = linkAlertMessage('recovered', { openedAt: 1794516679 }, { reasons: [] }, 1794538007)
  assert.match(recovered.summary, /recuper/)
  assert.equal(recovered.payload.state, 'recovered')
})
