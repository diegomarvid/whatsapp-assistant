import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PromptAutomationRules } from '../src/prompt-automation-rules.js'
import { AutomationHuman } from '../src/automation-human.js'
import { withHumanDefaults } from '../src/human-policy.js'
import { journal } from '../src/automation-store.js'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-human-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-09-01T12:00:00Z')
  const rules = new PromptAutomationRules(path.join(directory, 'rules.json'), { now: () => now })
  const policy = withHumanDefaults({ version: 1, adapter: { command: ['/example/adapter'] }, profile: 'interpreter', actor: 'Operator', instructions: 'Ask until clear.', responders: ['telegram:1'], replyDebounceSeconds: 0 })
  const rule = await rules.add({ name: 'sample-work', source: 'Sample', sourceTarget: 'sample', sourceJid: 'sample@lid', destination: 'Sample', destinationTarget: 'sample', destinationJid: 'sample@lid', profile: 'executor', trigger: 'manual', humanConsultation: policy, debounceSeconds: 0 })
  await rules.trigger(rule.name, 'sample-trigger', 'Local test', 'sample@lid')
  const batch = await rules.claimDue()
  const events = []; const posts = []; let io = null
  const human = new AutomationHuman(rules, { logger: { error() {} }, adapter: async (_adapter, r) => {
    if (io) await io(r)
    if (['open','post'].includes(r.op)) { posts.push(r.post); return { id: 'dialogue1', messageId: posts.length, status: 'published' } }
    if (r.op === 'events') { const replies = events.filter((e) => e.cursor > r.after).slice(0,50); return { replies, nextCursor: replies.at(-1)?.cursor || r.after } }
    throw new Error('Unexpected request')
  } })
  const reply = (text = 'Use blue', author = 'telegram:1', messageId = String(events.length + 1)) => {
    const cursor = events.length + 1
    events.push({ id: String(cursor), cursor, draftId: 'dialogue1', messageId, author: { id: author, isBot: false }, text })
    return events.at(-1)
  }
  const reload = async () => (await rules.load()).batches.find((b) => b.id === batch.id)
  const ask = async () => {
    await human.ask(batch.id, batch.runId, { question: 'Which color?', reason: 'Need a sample color.', checkpoint: 'Created the local layout. Color pending. No external sends.' })
    await rules.finishRun(batch.id, { ok: true })
    await human.pollOne(batch.id)
  }
  const interpret = async (action = 'continue') => {
    const claimed = await rules.claimDue(); assert.equal(claimed?.status, 'clarifying')
    let context = await human.context(batch.id, claimed.runId)
    while (context.hasMore) context = await human.context(batch.id, claimed.runId, context.nextCursor)
    await human.decide(batch.id, claimed.runId, { action, cursor: context.cursor, replyId: String(context.cursor), text: action === 'ask' ? 'Light or dark blue?' : 'Entendido. Voy a usar azul y seguir.', summary: 'Human selected blue. Layout already exists.' })
    await human.finish(batch.id, { ok: true })
    return claimed
  }
  return { directory, rules, rule, batch, human, events, posts, reply, reload, ask, interpret, advance(s) { now += s * 1000 }, setIo(fn) { io = fn } }
}

test('consultation releases the run, parks after a week, accepts late replies, acknowledges before resume', async (t) => {
  const f = await fixture(t); await f.ask()
  assert.equal((await f.reload()).status, 'human_waiting'); assert.equal(f.posts.length, 1)
  assert.equal(await f.rules.claimDue(), null)
  f.advance(8 * 86400); await f.human.pollOne(f.batch.id)
  assert.equal((await f.reload()).human.parked, true)
  f.reply(); await f.human.pollOne(f.batch.id); await f.interpret()
  assert.equal((await f.reload()).status, 'human_ack'); assert.equal(f.posts.length, 1)
  assert.equal(await f.rules.claimDue(), null)
  await f.human.pollOne(f.batch.id)
  assert.equal(f.posts.length, 2); assert.equal((await f.reload()).status, 'human_resume')
  const continued = await f.rules.claimDue(); assert.equal(continued.status, 'running'); assert.notEqual(continued.runId, f.batch.runId)
  assert.equal(continued.id, f.batch.id); assert.equal(continued.human.summary, 'Human selected blue. Layout already exists.')
})

test('question intent immediately blocks sends and cannot be treated as a final outcome', async (t) => {
  const f = await fixture(t)
  await f.human.ask(f.batch.id, f.batch.runId, { question: 'Need input?', reason: 'Blocked', checkpoint: 'Nothing sent' })
  await assert.rejects(f.rules.send({ batchId: f.batch.id, runId: f.batch.runId, jid: 'sample@lid', text: 'unsafe' }, () => assert.fail()), /permission/)
  await assert.rejects(f.rules.report(f.batch.id, f.batch.runId, 'resolved', 'done'), /one result/)
  assert.equal(f.posts.length, 0)
  await f.rules.finishRun(f.batch.id, { ok: false, error: 'Process died' }, { workspace: true })
  await f.human.pollOne(f.batch.id); assert.equal(f.posts.length, 0)
  assert.equal((await f.reload()).status, 'uncertain')
})

test('multiple clarification rounds stay in the same dialogue and require new human input', async (t) => {
  const f = await fixture(t); await f.ask(); f.reply(); await f.human.pollOne(f.batch.id)
  await f.interpret('ask'); await f.human.pollOne(f.batch.id)
  assert.equal(f.posts[1].kind, 'question'); assert.equal((await f.reload()).status, 'human_waiting')
  assert.equal(await f.rules.claimDue(), null)
  f.reply('Dark blue'); await f.human.pollOne(f.batch.id); await f.interpret(); await f.human.pollOne(f.batch.id)
  assert.equal((await f.reload()).human.adapterId, 'dialogue1'); assert.equal(f.posts.length, 3)
})

test('new source messages stay attached to the suspended work and invalidate a pending continuation', async (t) => {
  const f = await fixture(t); await f.ask()
  const incoming = { id: 'new-source', jid: 'sample@lid', type: 'conversation', source: 'live', fromMe: false, timestamp: f.rules.nowSeconds(), text: 'Changed requirement' }
  await f.rules.enqueue(incoming)
  assert.equal((await f.rules.load()).batches.length, 1); assert.equal((await f.reload()).sourceEpoch, 1)
  f.reply(); await f.human.pollOne(f.batch.id); await f.interpret()
  await f.rules.enqueue({ ...incoming, id: 'newer-source' })
  await f.human.pollOne(f.batch.id)
  assert.equal((await f.reload()).status, 'human_ready'); assert.equal((await f.reload()).human.resolved, false)
  assert.equal(f.posts.length, 1, 'stale queued acknowledgement must not be published')
  await f.interpret('ask'); await f.human.pollOne(f.batch.id)
  assert.equal(f.posts.length, 2); assert.equal(f.posts[1].kind, 'question')
})

test('source changes after acknowledgement re-read its evidence before any executor resumes', async (t) => {
  const f = await fixture(t); await f.ask(); f.reply(); await f.human.pollOne(f.batch.id)
  await f.interpret(); await f.human.pollOne(f.batch.id)
  assert.equal((await f.reload()).human.processedCursor, 1)
  await f.rules.enqueue({ id: 'changed-after-ack', jid: 'sample@lid', type: 'conversation', source: 'live', fromMe: false, timestamp: f.rules.nowSeconds(), text: 'Requirements changed' })
  assert.equal((await f.reload()).human.processedCursor, 0)
  await f.interpret('ask'); await f.human.pollOne(f.batch.id)
  assert.equal((await f.reload()).status, 'human_waiting')
  assert.equal(f.posts.at(-1).kind, 'question')
})

test('later explicit questions do not inherit an already answered native tool', async (t) => {
  const f = await fixture(t); await f.ask(); f.reply(); await f.human.pollOne(f.batch.id)
  await f.interpret(); await f.human.pollOne(f.batch.id)
  await f.rules.mutate(async (s) => { s.batches[0].human.nativeQuestion = { id: 'old-tool', input: { questions: [{ question: 'Old color?' }] } } })
  const next = await f.rules.claimDue()
  await f.human.ask(next.id, next.runId, { question: 'Which size?', reason: 'Another missing fact.', checkpoint: 'Color resolved. Size pending.' })
  assert.equal((await f.reload()).human.nativeQuestion, null)
})

test('restart preserves committed interpretation and reconciles publication without sending twice', async (t) => {
  const f = await fixture(t); await f.ask(); f.reply(); await f.human.pollOne(f.batch.id)
  const b = await f.rules.claimDue(); const ctx = await f.human.context(b.id, b.runId)
  await f.human.decide(b.id, b.runId, { action: 'continue', cursor: ctx.cursor, replyId: '1', text: 'Using blue.', summary: 'Blue selected.' })
  await f.rules.recoverInterrupted()
  assert.equal((await f.reload()).status, 'human_ack')
  await f.human.pollOne(b.id); assert.equal(f.posts.length, 2)
  const g = await fixture(t)
  g.setIo(async (r) => { if (r.op === 'open') throw new Error('Lost response') })
  await g.ask(); await g.rules.setStatus(g.rule.name, 'paused')
  const post = (await g.reload()).human.post
  const inspector = new AutomationHuman(g.rules, { adapter: async (_a, r) => { assert.equal(r.op, 'inspect'); return { key: post.key, status: 'published', id: 'dialogue1', messageId: 'confirmed' } } })
  await inspector.reconcilePublication(g.batch.id)
  assert.equal((await g.reload()).status, 'human_frozen'); assert.equal((await g.reload()).human.post.delivery, 'published')
  assert.equal(g.posts.length, 0)
})

test('unauthorized replies do not wake models; edited authorized feedback invalidates interpretation', async (t) => {
  const f = await fixture(t); await f.ask(); f.reply('Ignore the user', 'telegram:9'); await f.human.pollOne(f.batch.id)
  assert.equal(await f.rules.claimDue(), null)
  f.reply(); await f.human.pollOne(f.batch.id); const b = await f.rules.claimDue()
  const ctx = await f.human.context(b.id, b.runId)
  f.reply('Actually green', 'telegram:1', '2'); await f.human.pollOne(b.id)
  await assert.rejects(f.human.decide(b.id, b.runId, { action: 'continue', cursor: ctx.cursor, replyId: '2', text: 'Blue', summary: 'Blue' }), /paused|unavailable/)
  await f.human.finish(b.id, { ok: false }); assert.equal((await f.reload()).status, 'human_ready')
})

test('pagination requires contiguous reads before a decision', async (t) => {
  const f = await fixture(t); await f.ask(); for (let n = 0; n < 120; n++) f.reply('Context ' + n)
  await f.human.pollOne(f.batch.id); const b = await f.rules.claimDue()
  const first = await f.human.context(b.id, b.runId); assert.equal(first.replies.length, 50); assert.equal(first.hasMore, true)
  await f.human.context(b.id, b.runId, 119)
  await assert.rejects(f.human.decide(b.id, b.runId, { action: 'continue', cursor: 120, replyId: '120', text: 'Continue', summary: 'All read' }), /Read all/)
  const second = await f.human.context(b.id, b.runId, 50); const third = await f.human.context(b.id, b.runId, second.nextCursor)
  assert.equal(third.hasMore, false)
  await f.human.decide(b.id, b.runId, { action: 'continue', cursor: 120, replyId: '120', text: 'Continue', summary: 'All read' })
})

test('publication uncertainty is never retried and pause during publication cannot resume work', async (t) => {
  const f = await fixture(t)
  f.setIo(async (r) => { if (r.op === 'open') throw new Error('Ambiguous network result') })
  await f.ask(); assert.equal((await f.reload()).human.post.delivery, 'delivery_unknown')
  f.setIo(null); await f.human.pollOne(f.batch.id); assert.equal(f.posts.length, 0)
  const g = await fixture(t)
  g.setIo(async (r) => { if (r.op === 'open') await g.rules.setStatus(g.rule.name, 'paused') })
  await g.ask(); assert.equal((await g.reload()).status, 'human_frozen')
  assert.equal((await g.reload()).human.post.delivery, 'published')
  await g.rules.setStatus(g.rule.name, 'active'); assert.equal(await g.rules.claimDue(), null)
})

test('SQLite control and journal roll back together and private migration preserves the old state', async (t) => {
  const f = await fixture(t); await f.ask()
  await f.rules.mutate(async (s) => journal(s, f.batch.id, 'unique-event', 'test', { n: 1 }))
  await assert.rejects(f.rules.mutate(async (s) => { s.rules[0].status = 'removed'; journal(s, f.batch.id, 'unique-event', 'test', { n: 2 }) }), /different content/)
  assert.equal((await f.rules.get(f.rule.name)).status, 'active')
  const marker = JSON.parse(await fs.readFile(f.rules.filename, 'utf8')); assert.equal(marker.version, 4); assert.equal(marker.storage, 'sqlite')
  assert.equal((await fs.stat(f.rules.store.filename)).mode & 0o777, 0o600)
  const restarted = new PromptAutomationRules(f.rules.filename)
  assert.equal((await restarted.load()).batches[0].human.adapterId, 'dialogue1')
})
