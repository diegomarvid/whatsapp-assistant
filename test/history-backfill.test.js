import test from 'node:test'
import assert from 'node:assert/strict'
import { HistoryBackfill } from '../src/history-backfill.js'

const DAY = 86400
const NOW = 100 * DAY

// A fake phone holding the full history of each chat. Every on-demand request
// returns the page before the anchor and notifies the job, like the bridge does
// after ingesting an ON_DEMAND history set.
function harness({ phone, mirror, stubs = [], answers = true }) {
  const requests = []
  const resends = []
  const backfill = new HistoryBackfill({
    now: () => NOW,
    sleep: async () => {},
    pauseMs: 0,
    repairPauseMs: 0,
    responseTimeoutMs: 20,
    chats: () => Object.keys(mirror).map((jid) => ({ jid, latestAt: Math.max(...mirror[jid].map((message) => message.timestamp), 0) })),
    messagesFor: async (jid) => mirror[jid] || [],
    undecrypted: () => stubs,
    requestResend: async (key) => { resends.push(key.id) },
    fetchHistory: async (count, key, timestampMs) => {
      requests.push([key.remoteJid, key.id, timestampMs])
      if (!answers) return
      const older = (phone[key.remoteJid] || []).filter((message) => message.timestamp * 1000 < timestampMs).slice(-count)
      setImmediate(() => {
        mirror[key.remoteJid].push(...older)
        backfill.notifyOnDemand()
      })
    },
  })
  return { backfill, requests, resends }
}

function day(jid, days, id = `${jid}-${days}`) {
  return { jid, id, timestamp: NOW - (days * DAY), fromMe: false, type: 'conversation' }
}

async function finish(backfill) {
  await backfill.job
  return backfill.status()
}

test('pages each chat back until the retention window is covered or the chat starts', async () => {
  const phoneHistory = Array.from({ length: 120 }, (_, index) => day('busy@lid', 119 - index))
  const phone = { 'busy@lid': phoneHistory, 'new@lid': [day('new@lid', 3), day('new@lid', 1)] }
  const mirror = { 'busy@lid': phoneHistory.slice(-2), 'new@lid': [day('new@lid', 1)] }
  const { backfill, requests } = harness({ phone, mirror })
  backfill.pageSize = 50
  backfill.start({ days: 90, repair: false })
  const status = await finish(backfill)

  assert.equal(status.result, 'complete')
  assert.ok(Math.min(...mirror['busy@lid'].map((message) => message.timestamp)) <= NOW - (90 * DAY), 'the busy chat reaches the window')
  assert.equal(status.chats.reachedWindow, 1)
  assert.equal(status.chats.startOfChat, 1, 'a chat younger than the window stops when the phone has nothing older')
  assert.equal(status.chats.done, 2)
  assert.equal(requests.filter(([jid]) => jid === 'busy@lid').length, 2, 'two pages of 50 cover 90 days of a 120-message chat')
})

test('repair asks the phone to resend undecryptable placeholders inside the window only', async () => {
  const mirror = { 'a@lid': [day('a@lid', 95)] }
  const stubs = [{ ...day('g@g.us', 2, 'STUB-1'), participant: 'ana@lid' }, day('a@lid', 120, 'TOO-OLD'), day('status@broadcast', 1, 'STATUS')]
  const { backfill, resends } = harness({ phone: {}, mirror, stubs })
  backfill.start({ days: 90 })
  const status = await finish(backfill)
  assert.deepEqual(resends, ['STUB-1'])
  assert.deepEqual(status.repair, { candidates: 1, requested: 1, failed: 0 })
})

test('a phone that stops answering ends the job instead of looping', async () => {
  const mirror = { 'a@lid': [day('a@lid', 1)], 'b@lid': [day('b@lid', 1)], 'c@lid': [day('c@lid', 1)], 'd@lid': [day('d@lid', 1)] }
  const { backfill, requests } = harness({ phone: {}, mirror, answers: false })
  backfill.start({ days: 90, repair: false })
  const status = await finish(backfill)
  assert.equal(status.result, 'failed')
  assert.equal(status.error, 'phone_not_responding')
  assert.equal(requests.length, 3)
  assert.equal(status.timeouts, 3)
})

test('only one job runs at a time and stop ends it cleanly', async () => {
  const mirror = { 'a@lid': [day('a@lid', 1)] }
  const { backfill } = harness({ phone: {}, mirror, answers: false })
  backfill.responseTimeoutMs = 10_000
  backfill.start({ days: 90, repair: false })
  assert.throws(() => backfill.start({ days: 90 }), /backfill_running/)
  await new Promise((resolve) => setImmediate(resolve))
  backfill.stop()
  const status = await finish(backfill)
  assert.equal(status.result, 'stopped')
  assert.equal(status.running, false)
})

test('an explicit chat list skips broadcast and newsletter JIDs', async () => {
  const mirror = { 'a@lid': [day('a@lid', 95)] }
  const { backfill, requests } = harness({ phone: {}, mirror })
  backfill.start({ days: 90, jids: ['a@lid', 'status@broadcast', '123@newsletter'], repair: false })
  const status = await finish(backfill)
  assert.equal(status.chats.total, 1)
  assert.equal(requests.length, 0, 'a chat already covering the window needs no request')
})

test('the anchor is the oldest visible message, never a placeholder, reaction or protocol event', async () => {
  const mirror = { 'a@lid': [
    { ...day('a@lid', 9, 'STUB'), type: 'unknown', undecrypted: true },
    { ...day('a@lid', 8, 'KEYS'), type: 'senderKeyDistributionMessage' },
    { ...day('a@lid', 7, 'REACT'), type: 'reactionMessage' },
    day('a@lid', 5, 'REAL'),
  ] }
  const { backfill, requests } = harness({ phone: {}, mirror })
  backfill.start({ days: 90, repair: false })
  await finish(backfill)
  assert.deepEqual(requests[0].slice(0, 2), ['a@lid', 'REAL'])
})

test('a late answer to an earlier request is not credited to the next chat', () => {
  const backfill = new HistoryBackfill({ fetchHistory: async () => {}, requestResend: async () => {}, chats: () => [], messagesFor: async () => [], undecrypted: () => [] })
  backfill.pastRequests = new Set(['REQ-1', 'REQ-2'])
  let answered = null
  backfill.waitForResponse(['b@lid']).then((value) => { answered = value })
  backfill.waiter.requestId = 'REQ-2'
  backfill.notifyOnDemand({ sessionId: 'REQ-1', jids: [] })
  assert.ok(backfill.waiter, 'an answer to REQ-1 must not resolve the wait for REQ-2')
  backfill.notifyOnDemand({ sessionId: null, jids: ['a@lid'] })
  assert.ok(backfill.waiter, 'an answer about another chat must not resolve it either')
  backfill.notifyOnDemand({ sessionId: 'REQ-2', jids: [] })
  assert.equal(backfill.waiter, null, 'the matching session resolves it even when the phone had nothing older')
  return Promise.resolve().then(() => assert.equal(answered, true))
})

test('repair is limited to recent placeholders, newest first, and only those answers are past messages', async () => {
  const stubs = Array.from({ length: 5 }, (_, index) => ({ ...day('g@g.us', index + 1, `S${index}`), type: 'unknown', undecrypted: true }))
  stubs.push({ ...day('g@g.us', 20, 'OLD'), type: 'unknown', undecrypted: true })
  const { backfill, resends } = harness({ phone: {}, mirror: {}, stubs })
  backfill.maxRepairsPerRun = 3
  backfill.start({ days: 90 })
  await finish(backfill)
  assert.deepEqual(resends, ['S0', 'S1', 'S2'], 'newest first, capped, nothing older than 14 days')
  assert.equal(backfill.takeResendAnswer('S1'), true)
  assert.equal(backfill.takeResendAnswer('S1'), false, 'each requested ID is consumed once')
  assert.equal(backfill.takeResendAnswer('LIVE-STUB'), false, 'resends Baileys requested by itself stay live')
})
