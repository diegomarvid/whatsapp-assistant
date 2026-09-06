import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PromptAutomationRules } from '../src/prompt-automation-rules.js'
import { AutomationReviews, currentDraft } from '../src/automation-reviews.js'
import { AutomationWorker } from '../src/automation-worker.js'
import { AutomationCapabilities } from '../src/automation-capabilities.js'
import { latestReplies, runReviewAdapter, validateReviewPolicy, validateReplyPage } from '../src/review-adapter.js'
import { maspeakDrafts } from '../src/review-adapters/maspeak-drafts.js'

const policy = { version: 1, adapter: { command: ['/test/adapter'] }, profile: 'interpreter', actor: 'Operator', instructions: 'Interpret explicit human feedback; ambiguity means wait.', reviewers: ['test:alice', 'test:bob'], pollSeconds: 5, expiresSeconds: 3600, maxRevisions: 3 }
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-draft-tests-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-09-06T12:00:00Z')
  const rules = new PromptAutomationRules(path.join(directory, 'rules.json'), { now: () => now })
  const rule = await rules.add({ name: 'generic-task', source: 'Source', sourceTarget: 'source@g.us', sourceJid: 'source@g.us', destination: 'Destination', destinationTarget: 'dest@g.us', destinationJid: 'dest@g.us', profile: 'executor', debounceSeconds: 0, review: structuredClone(policy), ...options })
  let sequence = 0; const published = []; const sent = []; const feed = []; let online = true; let fresh = true
  const adapter = async (_config, request) => {
    if (request.op === 'publish') { published.push(request); return { status: 'published', id: `D-${published.length}`, messageId: published.length } }
    const replies = feed.filter((e) => e.draftId === request.draftId && e.cursor > request.after).slice(0, 50)
    return { replies, nextCursor: replies.at(-1)?.cursor || request.after }
  }
  const reviews = new AutomationReviews(rules, { adapter, connected: () => online, coverage: async () => ({ fresh }), resolveJid: async (jid) => jid, transport: async (jid, text, id) => { sent.push({ jid, text, id }); return { key: { id } } } })
  const message = () => ({ jid: rule.sourceJid, id: `IN-${++sequence}`, source: 'live', type: 'conversation', fromMe: false, timestamp: Math.floor(now / 1000) })
  const start = async () => { await rules.enqueue(message()); return rules.claimDue() }
  const get = async (batch) => (await rules.batchesFor(rule.id)).find((b) => b.id === batch.id)
  const submit = async (batch) => { await reviews.submit(batch.id, batch.runId, { text: 'Exact proposed text', reason: 'Why this is useful now', jid: rule.destinationJid }); await rules.finishRun(batch.id, { ok: true }); await reviews.pollOne(batch.id) }
  const reply = (draftId = 'D-1', fields = {}) => { const cursor = feed.length + 1; const event = { id: String(cursor), cursor, draftId, messageId: `M-${cursor}`, author: { id: 'test:alice' }, text: 'Human feedback is raw data', ...fields }; feed.push(event); return event }
  const decide = async (batch, action = 'approve', extra = {}) => {
    const context = await reviews.context(batch.id)
    return reviews.decide(batch.id, batch.runId, { action, revision: context.revision.number, cursor: context.revision.cursor, replyId: context.replies.at(-1)?.id, reason: 'Interpreted the full current feedback', ...extra })
  }
  return { directory, rules, rule, reviews, published, sent, feed, adapter, message, start, get, submit, reply, decide, advance(s) { now += s * 1000 }, offline() { online = false }, stale() { fresh = false } }
}

test('review policy is opt-in, validates identities and shell-free adapter configuration', () => {
  validateReviewPolicy(null); validateReviewPolicy(policy)
  assert.throws(() => validateReviewPolicy({ ...policy, reviewers: [] }), /identit/)
  assert.throws(() => validateReviewPolicy({ ...policy, adapter: { command: 'sh arbitrary' } }), /argv/)
  assert.throws(() => validateReviewPolicy({ ...policy, pollSeconds: 0 }), /limits/)
})

test('new reviews default to seven days and accept human feedback the next day after recovery', async (t) => {
  const { expiresSeconds: _expiry, ...withoutExpiry } = policy
  const f = await fixture(t, { review: withoutExpiry })
  assert.equal(f.rule.review.expiresSeconds, 604800)
  const batch = await f.start(); await f.submit(batch)
  f.advance(86400 + 60)
  await f.rules.recoverInterrupted(); await f.reviews.recover()
  await f.reviews.pollOne(batch.id)
  assert.equal((await f.get(batch)).status, 'review_waiting')
  assert.equal(await f.rules.claimDue(), null)
  f.reply(); await f.reviews.pollOne(batch.id)
  const reviewer = await f.rules.claimDue(); await f.decide(reviewer)
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  await f.reviews.pollOne(batch.id)
  assert.equal(f.sent.length, 1)
})

test('expiry can be extended for future and current drafts without reviving closed or expired work', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  const original = (await f.get(batch)).review.revisions[0].createdAt
  f.advance(1800)
  assert.equal((await f.rules.setReviewExpiry(f.rule.name, 604800)).pendingUpdated, 1)
  assert.equal((await f.get(batch)).review.expiresAt, new Date(Date.parse(original) + 604800000).toISOString())
  f.advance(86400); await f.reviews.pollOne(batch.id)
  assert.equal((await f.get(batch)).status, 'review_waiting')
  f.advance(7 * 86400)
  assert.equal((await f.rules.setReviewExpiry(f.rule.name, 30 * 86400)).pendingUpdated, 0)
  await f.reviews.pollOne(batch.id)
  assert.equal((await f.get(batch)).status, 'canceled')
  await f.rules.setStatus(f.rule.name, 'paused')
  assert.equal((await f.rules.setReviewExpiry(f.rule.name, 604800)).status, 'paused')
  assert.equal((await f.get(batch)).status, 'canceled')
  await assert.rejects(f.rules.setReviewExpiry(f.rule.name, 0), /limits/)
  assert.equal((await f.rules.get(f.rule.name)).review.expiresSeconds, 604800)
})

test('v2 migration keeps legacy rules direct and preserves control state', async (t) => {
  const f = await fixture(t, { review: null, mode: 'observe', status: 'paused' })
  const state = await f.rules.load(); state.version = 2
  delete state.rules[0].review; delete state.rules[0].trigger
  await fs.writeFile(f.rules.filename, JSON.stringify(state), { mode: 0o600 })
  await f.rules.recoverInterrupted()
  const migrated = await f.rules.load()
  assert.equal(migrated.version, 4)
  assert.equal(migrated.rules[0].review, null)
  assert.equal(migrated.rules[0].trigger, 'messages')
  assert.equal(migrated.rules[0].status, 'paused')
  assert.equal(migrated.rules[0].mode, 'observe')
})

test('observation and judge stages cannot publish draft proposals', async (t) => {
  for (const options of [{ mode: 'observe' }, { judgeProfile: 'judge' }]) {
    const f = await fixture(t, options); const batch = await f.start()
    await assert.rejects(f.reviews.submit(batch.id, batch.runId, { text: 'Draft', reason: 'Context', jid: f.rule.destinationJid }), /no longer active|Only the active executor/)
    assert.equal(f.published.length, 0)
  }
})

test('persistent draft publishes with context, sleeps without AI, and sends exact approved version once', async (t) => {
  const f = await fixture(t); const batch = await f.start()
  await assert.rejects(f.rules.send({ batchId: batch.id, runId: batch.runId, jid: f.rule.destinationJid, text: 'bypass' }, () => assert.fail()), /reviewed draft/)
  await f.submit(batch)
  assert.equal(f.published[0].draft.context.actor, 'Operator')
  assert.equal(f.published[0].draft.context.automation, f.rule.name)
  assert.equal((await f.get(batch)).status, 'review_waiting')
  for (let i = 0; i < 3; i++) { await f.reviews.pollOne(batch.id); assert.equal(await f.rules.claimDue(), null) }
  f.reply(); await f.reviews.pollOne(batch.id)
  const interpreter = await f.rules.claimDue()
  assert.equal(interpreter.status, 'reviewing')
  await f.decide(interpreter)
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  const restarted = new PromptAutomationRules(f.rules.filename)
  assert.equal(currentDraft((await restarted.load()).batches[0]).decision.action, 'approve')
  await f.reviews.pollOne(batch.id); await f.reviews.pollOne(batch.id)
  assert.equal(f.sent.length, 1)
  assert.deepEqual([f.sent[0].jid, f.sent[0].text], ['dest@g.us', 'Exact proposed text'])
  assert.equal((await f.get(batch)).status, 'completed')
  await f.rules.enqueue({ ...f.message(), jid: f.rule.destinationJid, id: f.sent[0].id, fromMe: true })
  assert.equal((await f.rules.load()).batches.length, 1)
})

test('revisions keep history and require fresh approval on the new draft', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id)
  const reviewer = await f.rules.claimDue()
  await f.decide(reviewer, 'revise', { text: 'Corrected message' })
  await f.reviews.pollOne(batch.id)
  assert.equal(f.published.length, 1, 'must not publish before review run finishes')
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  await f.reviews.pollOne(batch.id)
  assert.equal(f.published[1].draft.parentId, 'D-1')
  assert.notEqual(f.published[1].draft.key, f.published[0].draft.key)
  f.reply('D-1', { text: 'Approve old version' }); await f.reviews.pollOne(batch.id)
  assert.equal(await f.rules.claimDue(), null)
  assert.equal(f.sent.length, 0)
  f.reply('D-2'); await f.reviews.pollOne(batch.id)
  const next = await f.rules.claimDue(); await f.decide(next)
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' }); await f.reviews.pollOne(batch.id)
  assert.equal(f.sent[0].text, 'Corrected message')
  assert.equal((await f.get(batch)).review.revisions.length, 2)
})

test('untrusted members and bot identities do not wake the interpreter or authorize sends', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply('D-1', { author: { id: 'test:mallory' } }); f.reply('D-1', { author: { id: 'test:alice', isBot: true } }); f.reply('D-1', { senderChat: { id: 'anonymous-channel' } })
  await f.reviews.pollOne(batch.id)
  assert.equal(await f.rules.claimDue(), null)
  f.reply(); await f.reviews.pollOne(batch.id); const reviewer = await f.rules.claimDue()
  await assert.rejects(f.decide(reviewer, 'approve', { replyId: '1' }), /authorized reviewer/)
  assert.equal(f.sent.length, 0)
})

test('edits on later pages revoke approval before delivery and expose only latest text', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  const original = f.reply(); await f.reviews.pollOne(batch.id)
  const reviewer = await f.rules.claimDue(); await f.decide(reviewer)
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  for (let i = 0; i < 50; i++) f.reply('D-1', { author: { id: 'test:outsider' } })
  f.reply('D-1', { messageId: original.messageId, edited: true, text: 'Changed human feedback' })
  await f.reviews.pollOne(batch.id)
  assert.equal(f.sent.length, 0)
  const context = await f.reviews.context(batch.id)
  assert.equal(context.revision.cursor, 52)
  assert.equal(context.replies.filter((r) => r.messageId === original.messageId).length, 1)
  assert.equal(context.replies.at(-1).text, 'Changed human feedback')
  const next = await f.rules.claimDue()
  await assert.rejects(f.decide(next, 'approve', { replyId: original.id }), /current reply/)
  await f.decide(next, 'cancel')
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  assert.equal((await f.get(batch)).status, 'canceled')
})

test('new replies while interpreting invalidate that run and requeue interpretation', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id); const reviewer = await f.rules.claimDue()
  f.reply(); await f.reviews.pollOne(batch.id)
  await assert.rejects(f.decide(reviewer), /no longer active/)
  await f.rules.finishRun(batch.id, { ok: false }, { stage: 'review' })
  assert.equal((await f.get(batch)).status, 'review_ready')
  assert.equal((await f.rules.claimDue()).status, 'reviewing')
})

test('wait advances the processing cursor, and only new human feedback wakes the model', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id); const reviewer = await f.rules.claimDue()
  await f.decide(reviewer, 'wait'); await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  await f.reviews.pollOne(batch.id)
  assert.equal(await f.rules.claimDue(), null)
  f.reply(); await f.reviews.pollOne(batch.id)
  assert.equal((await f.rules.claimDue()).status, 'reviewing')
})

test('untranscribed audio is not approval; text restatement can be considered after waiting', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply('D-1', { audio: { mimeType: 'audio/ogg' }, text: null }); await f.reviews.pollOne(batch.id)
  const reviewer = await f.rules.claimDue()
  await assert.rejects(f.decide(reviewer), /Untranscribed/)
  await f.decide(reviewer, 'wait'); await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  f.reply(); await f.reviews.pollOne(batch.id)
  await f.decide(await f.rules.claimDue())
})

test('pause, human takeover, expiry and new source messages prevent reviewed delivery', async (t) => {
  for (const control of ['pause', 'human', 'expiry', 'source']) {
    const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
    f.reply(); await f.reviews.pollOne(batch.id); await f.decide(await f.rules.claimDue())
    await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
    if (control === 'pause') await f.rules.setStatus(f.rule.name, 'paused')
    if (control === 'human') await f.rules.setHuman(f.rule.name, true)
    if (control === 'expiry') f.advance(3601)
    if (control === 'source') await f.rules.enqueue(f.message())
    await f.reviews.pollOne(batch.id)
    assert.equal(f.sent.length, 0, control)
  }
})

test('exact text and recipient are enforced even with a valid stored approval', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id); await f.decide(await f.rules.claimDue())
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  const draft = currentDraft(await f.get(batch))
  for (const change of [{ text: 'Changed after approval' }, { jid: 'other@g.us' }]) {
    await assert.rejects(f.rules.send({ batchId: batch.id, reviewKey: draft.key, jid: draft.targetJid, text: draft.text, ...change }, () => assert.fail()), /exact draft/)
  }
})

test('publication ambiguity and interrupted publication never repost, even on restart', async (t) => {
  for (const crash of [false, true]) {
    const f = await fixture(t); const batch = await f.start()
    await f.reviews.submit(batch.id, batch.runId, { text: 'Draft', reason: 'Context', jid: 'dest@g.us' }); await f.rules.finishRun(batch.id, { ok: true })
    if (crash) {
      await f.rules.mutate(async (state) => { currentDraft(state.batches[0]).delivery = 'publishing'; return {} })
      await f.reviews.recover()
    } else {
      f.reviews.adapter = async () => ({ status: 'delivery_unknown', id: 'maybe-published' })
      await f.reviews.pollOne(batch.id)
    }
    await f.reviews.pollOne(batch.id)
    assert.equal((await f.get(batch)).status, 'uncertain')
    assert.equal(currentDraft(await f.get(batch)).delivery, 'delivery_unknown')
    assert.equal(f.published.length, 0)
    await assert.rejects(f.rules.retry(batch.id), /Only failed/)
  }
})

test('ambiguous WhatsApp delivery is retained and cannot be resent', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id); await f.decide(await f.rules.claimDue())
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
  let attempts = 0
  f.reviews.transport = async () => { attempts++; throw new Error('Connection lost after transmission') }
  await f.reviews.pollOne(batch.id); await f.reviews.recover(); await f.reviews.pollOne(batch.id)
  assert.equal(attempts, 1)
  assert.equal((await f.get(batch)).status, 'uncertain')
  assert.equal((await f.rules.get(f.rule.name)).humanHold, true)
})

test('maximum revisions cancels instead of producing an endless review loop', async (t) => {
  const f = await fixture(t, { review: { ...policy, maxRevisions: 1 } }); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id)
  assert.equal((await f.decide(await f.rules.claimDue(), 'revise', { text: 'New version' })).action, 'cancel')
  await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' }); await f.reviews.pollOne(batch.id)
  assert.equal(f.published.length, 1); assert.equal(f.sent.length, 0)
})

test('operator can abandon a draft, but uncertainty must be inspected first', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  await f.rules.cancel(batch.id, 'No longer relevant')
  await f.reviews.pollOne(batch.id)
  assert.equal((await f.get(batch)).status, 'canceled'); assert.equal(f.sent.length, 0)
  const second = await f.start()
  await f.rules.uncertain(second.id, 'Unknown outcome')
  await assert.rejects(f.rules.cancel(second.id, 'Abandon'), /factual review/)
  await f.rules.review(second.id, 'Inspected the external service; abandoning this operation')
  await f.rules.cancel(second.id, 'Abandon verified operation')
  assert.equal((await f.get(second)).status, 'canceled')
})

test('review remains queued when disconnected, stale or the adapter read fails', async (t) => {
  for (const condition of ['offline', 'stale', 'adapter']) {
    const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
    f.reply(); await f.reviews.pollOne(batch.id); await f.decide(await f.rules.claimDue())
    await f.rules.finishRun(batch.id, { ok: true }, { stage: 'review' })
    if (condition === 'offline') f.offline()
    if (condition === 'stale') f.stale()
    if (condition === 'adapter') f.reviews.adapter = async () => { throw new Error('Service unavailable') }
    await f.reviews.pollOne(batch.id)
    assert.equal(f.sent.length, 0)
    assert.equal((await f.get(batch)).status, 'review_waiting')
  }
})

test('read-only review decisions survive interpreter failure and restart without replaying the model', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id); await f.decide(await f.rules.claimDue())
  await f.rules.recoverInterrupted()
  assert.equal((await f.get(batch)).status, 'review_waiting')
  await f.reviews.recover(); await f.reviews.pollOne(batch.id)
  assert.equal(f.sent.length, 1)
})

test('source changes missed by live enqueue supersede manual review through mirror repair', async (t) => {
  const f = await fixture(t, { trigger: 'manual' })
  await f.rules.trigger(f.rule.name, 'operation', 'Caller context', f.rule.sourceJid)
  const batch = await f.rules.claimDue(); await f.submit(batch)
  f.advance(1)
  await f.rules.reconcile([f.message()])
  assert.equal((await f.get(batch)).status, 'superseded')
  assert.equal(await f.rules.claimDue(), null)
})

test('concurrent publication claims cannot post the same draft twice', async (t) => {
  const f = await fixture(t); const batch = await f.start()
  await f.reviews.submit(batch.id, batch.runId, { text: 'Draft', reason: 'Context', jid: 'dest@g.us' }); await f.rules.finishRun(batch.id, { ok: true })
  let release; const pending = new Promise((resolve) => { release = resolve })
  let calls = 0
  f.reviews.adapter = async (...args) => { calls++; await pending; return f.adapter(...args) }
  const first = f.reviews.pollOne(batch.id)
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 1))
  await f.reviews.pollOne(batch.id)
  release(); await first
  assert.equal(calls, 1)
})

test('explicit triggers are generic and idempotent across restarts and mirror retention', async (t) => {
  const f = await fixture(t, { trigger: 'manual' })
  await f.rules.enqueue(f.message()); assert.equal(await f.rules.claimDue(), null)
  const batch = await f.rules.trigger(f.rule.name, 'caller-operation-123', 'Caller supplied context', f.rule.sourceJid)
  assert.deepEqual(batch.messageIds, [])
  await assert.rejects(f.rules.trigger(f.rule.name, 'caller-operation-123', 'Different context', f.rule.sourceJid), /different content/)
  await assert.rejects(f.rules.trigger(f.rule.name, 'different-key', 'Another operation', f.rule.sourceJid), /already has pending/)
  const claimed = await f.rules.claimDue(); await f.rules.report(claimed.id, claimed.runId, 'no_reply', 'No message appropriate'); await f.rules.finishRun(claimed.id, { ok: true })
  f.advance(30 * 86400)
  const replay = await f.rules.trigger(f.rule.name, 'caller-operation-123', 'Caller supplied context', f.rule.sourceJid)
  assert.equal(replay.id, batch.id); assert.equal(replay.status, 'completed')
})

test('review worker has read-only capabilities and never inherits executor workspace', async (t) => {
  const f = await fixture(t); const batch = await f.start(); await f.submit(batch)
  f.reply(); await f.reviews.pollOne(batch.id)
  const capabilities = new AutomationCapabilities()
  const profiles = { list: async () => [{ name: 'executor', workspace: { path: '/repo' } }, { name: 'interpreter' }], get: async (name) => ({ name, timeoutMs: 1000 }) }
  let calls = 0
  const worker = new AutomationWorker({ rules: f.rules, profiles, capabilities, stateDir: f.directory, connected: () => true, coverage: async () => ({ fresh: true }), resolveJid: async (jid) => jid, logger: { info() {}, error() {} }, run: async (_profile, input) => {
    calls++; assert.equal(input.stage, 'review'); assert.equal(input.batch.workspaceLock, null)
    const auth = capabilities.authorization(input.capabilityToken, 'master')
    assert.equal(capabilities.canSend(auth, f.rule.destinationJid), false)
    await f.decide(input.batch, 'wait'); return { ok: true }
  } })
  await worker.tick(); await worker.drain(); await worker.tick()
  assert.equal(calls, 1)
})

test('adapter protocol rejects skipped cursors, wrong drafts and preserves literal semantic content', async () => {
  const reply = { id: '1', cursor: 1, draftId: 'D', messageId: 'M', text: 'Sí, pero todavía no. $(do not execute)' }
  assert.deepEqual(validateReplyPage({ replies: [reply], nextCursor: 1 }, 'D', 0).replies[0], reply)
  assert.throws(() => validateReplyPage({ replies: [reply], nextCursor: 2 }, 'D', 0), /skipped/)
  assert.throws(() => validateReplyPage({ replies: [reply], nextCursor: 1 }, 'OTHER', 0), /Invalid/)
  assert.equal(latestReplies([reply, { ...reply, id: '2', cursor: 2, edited: true, text: 'changed' }])[0].text, 'changed')
  const result = await runReviewAdapter({ command: [process.execPath, '-e', 'let s=""; process.stdin.on("data", c => s+=c); process.stdin.on("end", () => process.stdout.write(s));'] }, { op: 'test', text: reply.text })
  assert.equal(result.text, reply.text)
})

test('Maspeak is an optional adapter: wraps send/revise and maps raw identity, edits and audio', async () => {
  const calls = []
  const run = async (command) => {
    calls.push(command)
    if (command.includes('replies')) return JSON.stringify({ ok: true, data: { replies: [{ reply_id: '1', cursor: 1, draft_id: 'D', message_id: 8, from: { id: 42, first_name: 'Reviewer' }, text: 'Raw opinion', edited: true, audio: { mime_type: 'audio/ogg', file_id: 'PRIVATE' } }], next_cursor: 1 } })
    return JSON.stringify({ ok: true, data: { id: 'D', message_id: 7, state: 'sent' } })
  }
  const config = { command: ['/private/cli', 'drafts'] }
  const draft = { key: 'stable-key', parentId: 'PARENT', revision: 2, text: 'Literal draft', target: { jid: 'target@g.us', label: 'Recipient' }, context: { actor: 'Owner', automation: 'general-rule', reason: 'Context for human' } }
  assert.equal((await maspeakDrafts({ version: 1, op: 'publish', draft }, config, run)).status, 'published')
  assert.ok(calls[0].includes('revise')); assert.ok(calls[0].includes('PARENT'))
  const value = (flag) => calls[0][calls[0].indexOf(flag) + 1]
  assert.equal(value('--target'), 'Recipient')
  assert.equal(calls[0].includes('target@g.us'), false)
  assert.equal(value('--automation'), 'general-rule')
  assert.equal(value('--reason'), 'Context for human')
  assert.equal(value('--revision'), '2')
  assert.equal(value('--text'), draft.text)
  const result = await maspeakDrafts({ version: 1, op: 'replies', draftId: 'D', after: 0 }, config, run)
  assert.equal(result.replies[0].author.id, 'telegram:42')
  assert.equal(result.replies[0].text, 'Raw opinion'); assert.equal(result.replies[0].edited, true)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
})
