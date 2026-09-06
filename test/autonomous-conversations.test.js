import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PromptAutomationRules } from '../src/prompt-automation-rules.js'
import { AutomationCapabilities } from '../src/automation-capabilities.js'
import { AutomationWorker } from '../src/automation-worker.js'

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-v2-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-09-06T12:00:00Z')
  const rules = new PromptAutomationRules(path.join(directory, 'rules.json'), { now: () => now })
  const rule = await rules.add({ name: 'test-group', source: 'Test group', sourceTarget: 'test@g.us', sourceJid: 'test@g.us', destination: 'Test group', destinationTarget: 'test@g.us', destinationJid: 'test@g.us', profile: 'executor', direction: 'any', debounceSeconds: 0, ...options })
  let seq = 0
  const message = (overrides = {}) => ({ jid: rule.sourceJid, id: `IN-${++seq}`, fromMe: false, timestamp: Math.floor(now / 1000), source: 'live', type: 'conversation', text: 'arbitrary untrusted content', ...overrides })
  const claim = async () => { await rules.enqueue(message()); return rules.claimDue() }
  const send = (batch, text = 'Respuesta', transport = async (messageId) => ({ key: { id: messageId } })) => rules.send({ batchId: batch.id, runId: batch.runId, jid: rule.destinationJid, text }, transport)
  const get = async (batch) => (await rules.batchesFor(rule.id)).find((item) => item.id === batch.id)
  return { directory, rules, rule, message, claim, send, get, advance(seconds) { now += seconds * 1000 } }
}

test('sliding debounce has a hard maximum and a bounded batch size', async (t) => {
  const { rules, message, advance } = await fixture(t, { debounceSeconds: 10, maxWaitSeconds: 15, maxBatchMessages: 3 })
  await rules.enqueue(message())
  advance(9); await rules.enqueue(message())
  advance(5); assert.equal(await rules.claimDue(), null)
  advance(1); const first = await rules.claimDue()
  assert.equal(first.messageIds.length, 2)
  await rules.complete(first.id, {})
  await rules.enqueue(message()); await rules.enqueue(message()); await rules.enqueue(message()); await rules.enqueue(message())
  const full = await rules.claimDue()
  assert.equal(full.messageIds.length, 3)
  assert.equal((await rules.load()).batches.filter((batch) => batch.status === 'pending')[0].messageIds.length, 1)
})

test('observe preview on a paused live rule cannot send or change human control', async (t) => {
  const { rules, rule, send, get } = await fixture(t, { status: 'paused', judgeProfile: 'judge' })
  const preview = await rules.preview(rule.name, ['EXISTING-ID'], rule.sourceJid)
  const judge = await rules.claimDue()
  assert.equal(judge.id, preview.id)
  await assert.rejects(send(judge), /no permission/)
  await rules.decide(judge.id, judge.runId, 'human', 'Personal question')
  await rules.finishRun(judge.id, { ok: true }, { stage: 'judge' })
  assert.equal((await rules.get(rule.name)).humanHold, false)
  assert.equal((await get(judge)).status, 'human')
})

test('judge is optional, records exactly one decision, and cannot send', async (t) => {
  const { rules, claim, send, get } = await fixture(t, { judgeProfile: 'judge' })
  const judge = await claim()
  assert.equal(judge.status, 'judging')
  await assert.rejects(send(judge), /no permission/)
  await assert.rejects(rules.decide(judge.id, 'wrong-run', 'ai', 'Bug'), /no longer active/)
  await rules.decide(judge.id, judge.runId, 'ai', 'Platform bug')
  await assert.rejects(rules.decide(judge.id, judge.runId, 'none', 'Changed'), /one decision/)
  await rules.finishRun(judge.id, { ok: true }, { stage: 'judge' })
  const executor = await rules.claimDue()
  assert.equal(executor.status, 'running')
  assert.notEqual(executor.runId, judge.runId)
  await send(executor)
  await rules.report(executor.id, executor.runId, 'resolved', 'Verified response sent')
  await rules.finishRun(executor.id, { ok: true })
  assert.equal((await get(executor)).sendCount, 1)
  assert.equal((await get(executor)).status, 'completed')
})

test('missing judge decision and missing executor outcome are explicit failures', async (t) => {
  const { rules, claim, get } = await fixture(t)
  const batch = await claim()
  await rules.finishRun(batch.id, { ok: true, output: 'Done!' })
  assert.equal((await get(batch)).status, 'failed')
  assert.match((await get(batch)).lastError, /without recording an outcome/)
})

test('human reply invalidates an in-flight send and keeps new messages for review', async (t) => {
  const { rules, rule, claim, send, message, get, advance } = await fixture(t, { humanTakeover: true, direction: 'incoming' })
  const batch = await claim()
  await rules.enqueue(message({ fromMe: true }))
  assert.equal((await rules.get(rule.name)).humanHold, true)
  await assert.rejects(send(batch), /human|superseded/)
  await rules.report(batch.id, batch.runId, 'no_reply', 'Diego took over; no message sent')
  await rules.finishRun(batch.id, { ok: true })
  assert.equal((await get(batch)).status, 'superseded')
  await rules.enqueue(message())
  assert.equal(await rules.claimDue(), null)
  advance(5)
  await rules.setHuman(rule.name, false)
  assert.equal(await rules.claimDue(), null, 'releasing does not replay held messages')
  await rules.enqueue(message())
  assert.ok(await rules.claimDue())
})

test('pause blocks send even with an already issued capability', async (t) => {
  const { rules, rule, claim, send } = await fixture(t)
  const batch = await claim()
  await rules.setStatus(rule.name, 'paused')
  await assert.rejects(send(batch), /paused/)
})

test('a new message suppresses stale output and the next job gets the partial work summary', async (t) => {
  const { rules, rule, claim, send, message, get } = await fixture(t)
  const batch = await claim()
  await rules.enqueue(message({ text: 'Ya lo resolví' }))
  await assert.rejects(send(batch), /superseded/)
  assert.equal(await rules.claimDue(), null, 'same conversation waits for the worker to finish')
  await rules.report(batch.id, batch.runId, 'no_reply', 'Checked source, made no changes; user solved it')
  await rules.finishRun(batch.id, { ok: true })
  const next = await rules.claimDue()
  assert.notEqual(next.id, batch.id)
  assert.equal((await get(batch)).status, 'superseded')
  assert.match(JSON.stringify(await rules.context(rule.id)), /user solved it/)
})

test('own automatic echoes never trigger even an any-direction group rule or human takeover', async (t) => {
  const { rules, rule, claim, send, message } = await fixture(t, { humanTakeover: true })
  const batch = await claim()
  const result = await send(batch)
  assert.deepEqual(await rules.enqueue(message({ id: result.id, fromMe: true })), [])
  assert.equal((await rules.get(rule.name)).humanHold, false)
  assert.equal((await rules.load()).batches.length, 1)
  // A restart retains the outbound origin before a delayed echo is observed.
  const reopened = new PromptAutomationRules(rules.filename)
  assert.deepEqual(await reopened.enqueue(message({ id: result.id, fromMe: true })), [])
})

test('concurrent repeat sends reuse one transport result; uncertain sends block even revised text', async (t) => {
  const { claim, send, rules } = await fixture(t)
  const batch = await claim()
  let calls = 0
  const transport = async (messageId) => { calls++; return { key: { id: messageId } } }
  const [a, b] = await Promise.all([send(batch, 'Hello', transport), send(batch, 'Hello', transport)])
  assert.equal(a.id, b.id)
  assert.equal(calls, 1)
  await assert.rejects(send(batch, 'Another', async () => { throw new Error('Connection lost') }), /Connection lost/)
  await assert.rejects(send(batch, 'Reworded', transport), /uncertain/)
  await rules.finishRun(batch.id, { ok: false, error: 'Interrupted' })
  await assert.rejects(rules.retry(batch.id), /uncertain work/)
})

test('an accepted send cannot bypass an observation result or the hourly loop breaker', async (t) => {
  const { rules, claim, send, rule } = await fixture(t, { maxRepliesPerHour: 1 })
  const batch = await claim()
  await send(batch)
  await assert.rejects(send(batch, 'Another'), /Hourly reply limit/)
  assert.equal((await rules.get(rule.name)).humanHold, true)
})

test('no new messages spends no model calls; observe executes with a read-only capability', async (t) => {
  const { rules, rule, directory, message } = await fixture(t, { mode: 'observe' })
  const capabilities = new AutomationCapabilities()
  let calls = 0
  const worker = new AutomationWorker({ rules, capabilities, stateDir: directory, profiles: { list: async () => [{ name: 'executor' }], get: async () => ({ name: 'executor', provider: 'codex', timeoutMs: 60000 }) }, connected: () => true, coverage: () => ({ fresh: true }), resolveJid: async (jid) => jid, logger: { info() {}, error() {} }, run: async (_, input) => {
    calls++
    const auth = capabilities.authorization(input.capabilityToken, 'master')
    assert.equal(capabilities.canRead(auth, rule.sourceJid), true)
    assert.equal(capabilities.canSend(auth, rule.destinationJid), false)
    await rules.report(input.batch.id, input.batch.runId, 'no_reply', 'Would respond to the message')
    return { ok: true }
  } })
  await worker.tick(); await worker.drain(); assert.equal(calls, 0)
  await rules.enqueue(message()); await worker.tick(); await worker.drain()
  assert.equal(calls, 1)
  assert.equal((await rules.batchesFor(rule.id))[0].status, 'observed')
  assert.equal(capabilities.records.size, 0)
})

test('different chats progress concurrently but a shared workspace stays serialized', async (t) => {
  const { rules, rule, message } = await fixture(t)
  await rules.add({ ...rule, name: 'other-chat', sourceTarget: 'other@g.us', sourceJid: 'other@g.us', sourceOriginalJid: 'other@g.us', destinationTarget: 'other@g.us', destinationJid: 'other@g.us', destinationOriginalJid: 'other@g.us', profile: 'other-profile' })
  await rules.enqueue(message()); await rules.enqueue(message({ jid: 'other@g.us' }))
  const first = await rules.claimDue({ workspaces: { executor: '/repo', 'other-profile': '/repo' } })
  assert.ok(first)
  assert.equal(await rules.claimDue({ workspaces: { executor: '/repo', 'other-profile': '/repo' } }), null)
  assert.ok(await rules.claimDue({ workspaces: { executor: '/repo', 'other-profile': '/other-repo' } }))
})

test('waiting jobs survive restart, preserve summaries and yield to new incoming messages', async (t) => {
  const { rules, rule, claim, message, advance, get } = await fixture(t)
  const batch = await claim()
  await rules.report(batch.id, batch.runId, 'waiting', 'Waiting for an authorized build to complete', 10)
  await rules.finishRun(batch.id, { ok: true })
  await rules.recoverInterrupted()
  assert.equal((await get(batch)).status, 'waiting')
  advance(10)
  assert.equal((await rules.claimDue()).id, batch.id)
  await rules.report(batch.id, (await get(batch)).runId, 'waiting', 'Build still running', 20)
  await rules.finishRun(batch.id, { ok: true })
  await rules.enqueue(message())
  assert.equal((await get(batch)).status, 'superseded')
  assert.match(JSON.stringify(await rules.context(rule.id)), /Build still running/)
})

test('repair sweep finds persisted but unqueued live messages and never replays processed IDs', async (t) => {
  const { rules, message } = await fixture(t)
  const incoming = message()
  assert.equal(await rules.reconcile([incoming, message({ source: 'history' })]), 1)
  assert.equal(await rules.reconcile([incoming]), 0)
  assert.equal((await rules.claimDue()).messageIds[0], incoming.id)
})

test('v1 migration preserves active rules, durable human jobs outlive normal audit retention', async (t) => {
  const { rules, rule, claim, advance } = await fixture(t)
  const state = await rules.load()
  delete state.outbound; state.version = 1
  for (const key of ['mode', 'judgeProfile', 'maxWaitSeconds', 'maxBatchMessages', 'humanHold', 'humanTakeover', 'maxRepliesPerHour']) delete state.rules[0][key]
  await fs.writeFile(rules.filename, JSON.stringify(state))
  assert.equal((await rules.get(rule.name)).mode, 'live')
  const batch = await claim()
  await rules.report(batch.id, batch.runId, 'needs_human', 'Needs a personal decision')
  await rules.finishRun(batch.id, { ok: true })
  advance(9 * 86400)
  await rules.setHuman(rule.name, false)
  assert.equal((await rules.batchesFor(rule.id))[0].status, 'human')
  assert.equal(JSON.parse(await fs.readFile(rules.filename)).version, 3)
})

test('messages arriving after an ai decision must be judged again', async (t) => {
  const { rules, claim, message } = await fixture(t, { judgeProfile: 'judge' })
  const batch = await claim()
  await rules.decide(batch.id, batch.runId, 'ai', 'Original bug')
  await rules.finishRun(batch.id, { ok: true }, { stage: 'judge' })
  await rules.enqueue(message({ text: 'Ahora quiero hablar del contrato' }))
  const next = await rules.claimDue()
  assert.equal(next.status, 'judging')
  assert.equal(next.decision, null)
})

test('judge human puts the conversation on hold; none finishes without the executor', async (t) => {
  const { rules, rule, claim } = await fixture(t, { judgeProfile: 'judge' })
  const first = await claim()
  await rules.decide(first.id, first.runId, 'none', 'Acknowledgment')
  await rules.finishRun(first.id, { ok: true }, { stage: 'judge' })
  assert.equal(await rules.claimDue(), null)
  const next = await claim()
  await rules.decide(next.id, next.runId, 'human', 'Owner decision required')
  await rules.finishRun(next.id, { ok: true }, { stage: 'judge' })
  assert.equal((await rules.get(rule.name)).humanHold, true)
  assert.equal(await rules.claimDue(), null)
})

test('uncertain workspace work blocks automatic continuation until reviewed', async (t) => {
  const { rules, rule, message } = await fixture(t)
  await rules.enqueue(message())
  const batch = await rules.claimDue({ workspaces: { executor: '/repo' } })
  await rules.finishRun(batch.id, { ok: false, error: 'Stopped' }, { workspace: true })
  await assert.rejects(rules.setHuman(rule.name, false), /Review uncertain/)
  await rules.review(batch.id, 'Checked the isolated workspace and confirmed no external changes')
  await rules.setHuman(rule.name, false)
  await rules.enqueue(message())
  assert.ok(await rules.claimDue({ workspaces: { executor: '/repo' } }))
})

test('freshness is checked again before the transport starts', async (t) => {
  const { rules, claim, rule } = await fixture(t)
  const batch = await claim()
  let sent = false
  await assert.rejects(rules.send({ batchId: batch.id, runId: batch.runId, jid: rule.sourceJid, text: 'Hello' }, async () => { sent = true }, () => false), /no longer fresh/)
  assert.equal(sent, false)
  assert.equal((await rules.load()).outbound.length, 0)
})

test('manual pause actively stops a provider instead of waiting for its full timeout', async (t) => {
  const { rules, rule, directory, message } = await fixture(t)
  let started
  const ready = new Promise((resolve) => { started = resolve })
  let aborted = false
  const worker = new AutomationWorker({ rules, capabilities: new AutomationCapabilities(), stateDir: directory, profiles: { list: async () => [{ name: 'executor' }], get: async () => ({ name: 'executor', timeoutMs: 60000 }) }, connected: () => true, coverage: () => ({ fresh: true }), resolveJid: async (jid) => jid, logger: { info() {}, error() {} }, run: async (_, input) => {
    started()
    return new Promise((resolve) => input.signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, error: 'Stopped' }) }, { once: true }))
  } })
  await rules.enqueue(message()); await worker.tick(); await ready
  await rules.setStatus(rule.name, 'paused')
  await worker.tick(); await worker.drain()
  assert.equal(aborted, true)
  assert.equal((await rules.batchesFor(rule.id))[0].status, 'superseded')
})
