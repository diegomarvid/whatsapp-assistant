import crypto from 'node:crypto'
import { journal } from './automation-store.js'
import { HUMAN_WAITING, commitHumanDecision } from './human-policy.js'
import { authorizedReply, latestReplies, runAdapterCommand, validateReplyPage } from './review-adapter.js'

const validText = (s, max) => typeof s === 'string' && s.trim() && s.length <= max
const authorized = (policy, event) => authorizedReply({ reviewers: policy.responders }, event)
export async function runHumanAdapter(adapter, request, { signal } = {}) {
  return JSON.parse(await runAdapterCommand(adapter.command, { cwd: adapter.cwd, signal, input: JSON.stringify({ ...request, version: 2 }) + '\n' }))
}
function eligible(state, batch) {
  const rule = state.rules.find((r) => r.id === batch?.ruleId)
  if (!rule?.humanConsultation || rule.status !== 'active' || rule.humanHold || rule.mode !== 'live' || batch.observe || batch.invalidated) throw new Error('Consultation is paused or unavailable for this work.')
  return rule
}

export class AutomationHuman {
  constructor(rules, { adapter = runHumanAdapter, logger = console } = {}) {
    Object.assign(this, { rules, adapter, logger })
    this.controller = new AbortController(); this.job = null; this.stopping = false
  }

  // Records an intent only. The worker publishes it after the provider exits
  // successfully. Both WhatsApp sends and draft submissions stop immediately.
  async ask(batchId, runId, { question, reason, checkpoint }) {
    if (!validText(question, 2000) || !validText(reason, 600) || !validText(checkpoint, 8000)) throw new Error('Ask requires question (1–2000), reason (1–600) and checkpoint (1–8000).')
    return this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId && b.runId === runId && b.status === 'running' && !b.report)
      const rule = eligible(state, batch)
      if (!batch || batch.review || state.outbound.some((o) => o.batchId === batchId && o.status !== 'accepted')) throw new Error('Cannot suspend uncertain work or an active draft.')
      const old = batch.human
      if (old && !old.resolved) throw new Error('This work already has an open consultation.')
      batch.human = { id: old?.id || crypto.randomUUID(), round: (old?.round || 0) + 1, cursor: old?.cursor || 0, processedCursor: old?.processedCursor || 0, nativeQuestion: null,
        nextPollAt: this.rules.nowIso(), lastActivityAt: this.rules.nowIso(), checkpoint, summary: old?.summary || '', resolved: false, adapterId: old?.adapterId || null,
        post: { key: `human-${batch.id}-${(old?.round || 0) + 1}`, text: question, reason, kind: 'question', delivery: 'queued' }, decision: null }
      batch.report = { outcome: 'awaiting_human', summary: reason, at: this.rules.nowIso() }
      journal(state, batch.id, `${batch.human.post.key}-checkpoint`, 'checkpoint', { checkpoint, question, reason, sourceEpoch: batch.sourceEpoch || 0, actor: rule.humanConsultation.actor })
      return { value: { recorded: true, instruction: 'Stop now. Do not start any more work or record another result. The service publishes the question only after this process exits safely.' } }
    })
  }

  async context(batchId, runId, after = null, sourceAfter = 0) {
    return this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId && b.runId === runId && ['running', 'clarifying'].includes(b.status))
      const rule = eligible(state, batch)
      const h = batch?.human
      if (!h) throw new Error('No human consultation for this run.')
      const start = after ?? (batch.status === 'running' ? Math.max(0, h.processedCursor - 50) : h.processedCursor)
      const events = await this.rules.store.events(batch.id, { after: start, replies: true })
      const replies = events.map((e) => ({ ...e.data, authorized: authorized(rule.humanConsultation, e.data) }))
      const nextCursor = replies.at(-1)?.cursor ?? start
      // Only contiguous reads can satisfy a decision. The client cannot claim
      // to have read a later cursor by simply passing it as an argument.
      if (batch.status === 'clarifying' && start === (h.readCursor ?? h.processedCursor)) h.readCursor = nextCursor
      const sources = await this.rules.store.events(batch.id, { after: sourceAfter, kind: 'source' })
      const sourceNextCursor = sources.at(-1)?.seq || sourceAfter
      const sourceHasMore = (await this.rules.store.events(batch.id, { after: sourceNextCursor, kind: 'source', limit: 1 })).length > 0
      if (batch.status === 'clarifying' && sourceAfter === (h.sourceReadCursor || 0)) { h.sourceReadCursor = sourceNextCursor; if (!sourceHasMore) h.sourceReadEpoch = batch.sourceEpoch || 0 }
      return { value: { workId: batch.id, sourceEvents: sources, sourceNextCursor, sourceHasMore, question: h.post.text, checkpoint: h.checkpoint, summary: h.summary, responders: rule.humanConsultation.responders,
        instructions: rule.humanConsultation.instructions, sourceEpoch: batch.sourceEpoch || 0, cursor: h.cursor, processedCursor: h.processedCursor,
        replies, nextCursor, hasMore: nextCursor < h.cursor, nativeQuestion: h.nativeQuestion || null, decision: h.decision || null } }
    })
  }

  async decide(batchId, runId, { action, cursor, replyId, text, summary, answers }) {
    if (!['ask', 'wait', 'continue', 'cancel'].includes(action) || !validText(text, 2000) || !validText(summary, 8000)) throw new Error('Use ask|wait|continue|cancel, text (1–2000) and an updated factual summary (1–8000).')
    return this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId && b.runId === runId && b.status === 'clarifying')
      const rule = eligible(state, batch); const h = batch?.human
      if (!h || h.decision || cursor !== h.cursor || h.readCursor !== cursor || cursor <= h.processedCursor || h.caughtUp !== true || h.sourceReadEpoch !== (batch.sourceEpoch || 0)) throw new Error('Read all current replies before deciding; feedback changed or a decision already exists.')
      const events = []
      let after = h.processedCursor
      while (after < cursor) {
        const page = await this.rules.store.events(batchId, { after, replies: true })
        if (!page.length) throw new Error('Consultation journal has a gap.')
        events.push(...page.map((e) => e.data)); after = page.at(-1).cursor
      }
      const latest = latestReplies(events)
      const evidence = latest.find((e) => e.id === replyId)
      if (action !== 'wait' && (!evidence || !authorized(rule.humanConsultation, evidence))) throw new Error('A current authorized human reply is required.')
      if (action === 'continue' && latest.some((e) => authorized(rule.humanConsultation, e) && e.audio && !e.transcript)) throw new Error('Untranscribed audio cannot authorize continuation. Ask for a text restatement.')
      if (action === 'continue' && h.nativeQuestion) {
        const questions = h.nativeQuestion.input.questions
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) || questions.some((q) => !validText(answers[q.question], 4000)) || Object.keys(answers).some((key) => !questions.some((q) => q.question === key))) throw new Error('Native questions require an answer for each original question, derived from the human feedback.')
      }
      h.decision = { action, text, summary, answers: action === 'continue' ? answers || null : null, inputCursor: h.processedCursor, cursor, replyId: evidence?.id || null, author: evidence?.author?.id || null, sourceEpoch: batch.sourceEpoch || 0, at: this.rules.nowIso() }
      journal(state, batch.id, `decision-${h.id}-${batch.runId}`, 'decision', h.decision)
      return { value: h.decision }
    })
  }

  tick() {
    if (this.stopping) return Promise.resolve()
    if (!this.job) this.job = this.poll().catch((err) => this.logger.error({ err }, 'Human consultation transport failed')).finally(() => { this.job = null })
    return this.job
  }
  stop() { this.stopping = true; this.controller.abort() }
  async beforeResume(batch) {
    const { rules, batches } = await this.rules.load()
    const current = batches.find((b) => b.id === batch.id && b.runId === batch.runId && b.status === 'running')
    const rule = eligible({ rules }, current)
    if (!current?.human?.resolved) return true
    const page = await this.adapter(rule.humanConsultation.adapter, { op: 'events', dialogueId: current.human.adapterId, after: current.human.cursor }, { signal: this.controller.signal })
    validateReplyPage(page, current.human.adapterId, current.human.cursor)
    if (!page.replies.length) return true
    await this.rules.mutate(async (state) => {
      const b = state.batches.find((b) => b.id === batch.id && b.runId === batch.runId); eligible(state, b)
      b.status = 'human_ready'; b.human.resolved = false; b.human.decision = null
      // The poller persists the new page. Interpretation remains blocked until
      // it has drained every page; nothing has executed in the resumed run.
      b.human.caughtUp = false; b.human.nextPollAt = this.rules.nowIso()
      b.human.processedCursor = Math.min(b.human.processedCursor, current.human.cursor)
    })
    return false
  }
  async reconcilePublication(batchId) {
    const state = await this.rules.load()
    const b = state.batches.find((b) => b.id === batchId && b.human)
    const policy = state.rules.find((r) => r.id === b?.ruleId)?.humanConsultation
    if (!b || !policy) throw new Error('Unknown consultation.')
    const post = b.human.post
    const result = await this.adapter(policy.adapter, { op: 'inspect', key: post.key }, { signal: this.controller.signal })
    if (result?.key !== post.key || result.status !== 'published' || !validText(result.id, 160) || !result.messageId) throw new Error('Publication remains unconfirmed. No resend or continuation was started.')
    return this.rules.mutate(async (state) => {
      const current = state.batches.find((b) => b.id === batchId)
      if (current?.human?.post.key !== post.key) throw new Error('Publication changed.')
      if (current.human.post.delivery === 'published') return { value: current.human.post, save: false }
      current.human.adapterId = result.id
      Object.assign(current.human.post, { delivery: 'published', messageId: String(result.messageId) })
      journal(state, batchId, post.key, 'post', { ...current.human.post, recovered: true })
      return { value: current.human.post }
    })
  }
  async poll() {
    const { batches } = await this.rules.load()
    const due = batches.filter((b) => HUMAN_WAITING.has(b.status) && b.status !== 'human_frozen' && b.human && Date.parse(b.human.nextPollAt) <= this.rules.now()).sort((a,b) => Date.parse(a.human.nextPollAt)-Date.parse(b.human.nextPollAt)).slice(0, 10)
    for (const b of due) { if (this.stopping) break; await this.pollOne(b.id) }
  }

  async pollOne(batchId) {
    let snapshot = await this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId)
      if (!batch?.human || !HUMAN_WAITING.has(batch.status) || batch.status === 'human_frozen') return { value: null, save: false }
      let rule; try { rule = eligible(state, batch) } catch { return { value: null, save: false } }
      batch.human.nextPollAt = new Date(this.rules.now() + rule.humanConsultation.pollSeconds * 1000).toISOString()
      return { value: { batch: structuredClone(batch), rule } }
    })
    if (!snapshot) return
    const { batch, rule } = snapshot; const h = batch.human; const policy = rule.humanConsultation
    try {
      if (h.post.delivery === 'publishing' || h.post.delivery === 'delivery_unknown') {
        const recovered = await this.adapter(policy.adapter, { op: 'inspect', key: h.post.key }, { signal: this.controller.signal })
        if (recovered?.status !== 'published' || recovered.key !== h.post.key || !validText(recovered.id, 160) || !recovered.messageId) throw new Error('Telegram publication is uncertain. Inspect its stable key before recovery; no automatic resend.')
        await this.rules.mutate(async (state) => {
          const b = state.batches.find((b) => b.id === batchId)
          if (b?.human?.post.key !== h.post.key) throw new Error('Publication changed.')
          if (b.human.post.delivery === 'published') return { save: false }
          b.human.adapterId = recovered.id
          Object.assign(b.human.post, { delivery: 'published', messageId: String(recovered.messageId) })
          journal(state, batchId, h.post.key, 'post', { ...b.human.post, recovered: true })
        })
      }
      if (h.post.delivery === 'queued' && ['human_waiting', 'human_ack'].includes(batch.status)) {
        // Persist intent before external I/O. Never hold a control lock across
        // the network, so pause/cancel remains responsive.
        await this.rules.mutate(async (state) => {
          const current = state.batches.find((b) => b.id === batchId); eligible(state, current)
          if (current.human.post.key !== h.post.key || current.human.post.delivery !== 'queued' || !['human_waiting', 'human_ack'].includes(current.status)) throw new Error('Publication changed.')
          current.human.post.delivery = 'publishing'
        })
        const result = await this.adapter(policy.adapter, { op: h.adapterId ? 'post' : 'open', dialogueId: h.adapterId,
          post: { ...h.post, actor: policy.actor, automation: rule.name, target: rule.destination } }, { signal: this.controller.signal })
        if (result?.status !== 'published' || !validText(result.id, 160) || !result.messageId) throw new Error('Telegram did not confirm the consultation message.')
        await this.rules.mutate(async (state) => {
          const current = state.batches.find((b) => b.id === batchId)
          if (current?.human?.post.key !== h.post.key) throw new Error('Publication identity changed.')
          current.human.adapterId = result.id
          Object.assign(current.human.post, { delivery: 'published', messageId: String(result.messageId) })
          journal(state, batchId, h.post.key, 'post', { ...current.human.post, at: this.rules.nowIso() })
          // Recording a real transport acknowledgement is allowed after pause,
          // but never changes a paused/frozen work back to runnable.
        })
      }
      const fresh = (await this.rules.load()).batches.find((b) => b.id === batchId)
      if (!fresh || fresh.status === 'human_frozen' || !HUMAN_WAITING.has(fresh.status)) return
      const current = fresh.human
      // Drain bounded pages per tick. If a backlog is larger, stay in transport
      // processing and spend no model calls until the end has been observed.
      let after = current.cursor; let caughtUp = false; const events = []
      for (let n = 0; n < 20; n++) {
        const page = await this.adapter(policy.adapter, { op: 'events', dialogueId: current.adapterId, after }, { signal: this.controller.signal })
        validateReplyPage(page, current.adapterId, after)
        events.push(...page.replies); after = page.nextCursor
        if (page.replies.length < 50) { caughtUp = true; break }
      }
      await this.rules.mutate(async (state) => {
        const b = state.batches.find((b) => b.id === batchId); eligible(state, b)
        if (!HUMAN_WAITING.has(b.status) || b.status === 'human_frozen' || b.human.cursor !== current.cursor) return { save: false }
        const v = b.human
        for (const event of events) journal(state, batchId, `reply-${v.id}-${event.cursor}`, 'reply', event, event.cursor)
        v.cursor = after; v.caughtUp = caughtUp; v.lastError = null
        const actionable = events.some((e) => authorized(policy, e))
        if (actionable) {
          v.lastActivityAt = this.rules.nowIso(); v.parked = false
          v.firstReplyAt ||= this.rules.nowIso()
          v.replyDueAt = new Date(Math.min(this.rules.now() + policy.replyDebounceSeconds * 1000, Date.parse(v.firstReplyAt) + policy.replyMaxWaitSeconds * 1000)).toISOString()
          // A decision is bound to ALL feedback read, including edits. Never
          // resume against a stale acknowledgement or interpretation.
          v.decision = null
          if (b.status === 'clarifying') { b.invalidated = 'New consultation feedback'; b.invalidationKind = 'human_replies' }
          else b.status = 'human_ready'
        } else if (events.length && v.decision) {
          // Even non-authorized events change the cursor: require a new read.
          v.decision = null
          if (b.status === 'clarifying') { b.invalidated = 'Consultation cursor changed'; b.invalidationKind = 'human_replies' }
          else b.status = 'human_ready'
        }
        if (!caughtUp) { v.nextPollAt = this.rules.nowIso(); return }
        if (b.status === 'human_ack' && v.post.delivery === 'published' && v.decision && v.decision.cursor === v.cursor) {
          if (v.decision.action === 'continue' && v.decision.sourceEpoch !== (b.sourceEpoch || 0)) { v.decision = null; b.status = 'human_ready'; return }
          v.processedCursor = v.cursor; v.summary = v.decision.summary; v.firstReplyAt = null
          if (v.decision.action === 'continue') {
            v.resolved = true; b.status = 'human_resume'; b.dueAt = this.rules.nowIso()
          } else if (v.decision.action === 'cancel') { b.status = 'canceled'; b.completedAt = this.rules.nowIso() }
          else { b.status = 'human_waiting'; v.decision = null }
        }
        if (this.rules.now() - Date.parse(v.lastActivityAt) > policy.idleAfterSeconds * 1000) v.parked = true
      })
    } catch (error) {
      await this.rules.mutate(async (state) => {
        const b = state.batches.find((b) => b.id === batchId)
        if (!b?.human) return { save: false }
        b.human.lastError = String(error.message).slice(0, 1000)
        if (b.human.post.delivery === 'publishing') b.human.post.delivery = 'delivery_unknown'
      })
    }
  }

  async finish(batchId, result) {
    return this.rules.mutate(async (state) => {
      const b = state.batches.find((b) => b.id === batchId && b.status === 'clarifying')
      if (!b) return { value: null, save: false }
      const h = b.human
      if (b.invalidationKind === 'human_replies') {
        Object.assign(b, { status: 'human_ready', invalidated: null, invalidationKind: null }); h.decision = null
      } else if (b.invalidated) { b.status = 'human_frozen' }
      else if (!result.ok || !h.decision) {
        b.status = 'human_frozen'; h.lastError = result.error || 'Interpreter exited without a decision. Inspect before resuming.'
      } else {
        commitHumanDecision(b, this.rules.nowIso())
      }
      return { value: structuredClone(b) }
    })
  }
}
