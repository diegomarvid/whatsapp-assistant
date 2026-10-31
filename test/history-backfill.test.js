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
  return { jid, id, timestamp: NOW - (days * DAY), fromMe: false }
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
