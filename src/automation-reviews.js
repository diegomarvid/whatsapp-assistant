import { authorizedReply, latestReplies, runReviewAdapter, validateReplyPage } from './review-adapter.js'

const WAITING = new Set(['review_waiting', 'review_ready', 'reviewing'])
const nonempty = (s, max) => typeof s === 'string' && s.trim() && s.length <= max
export const currentDraft = (batch) => batch.review?.revisions.at(-1)

function eligible(state, batch) {
  const rule = state.rules.find((r) => r.id === batch?.ruleId)
  if (!rule?.review || rule.status !== 'active' || rule.humanHold || rule.mode !== 'live' || batch.observe || batch.invalidated) throw new Error('Review is no longer active; no external action is allowed.')
  return rule
}

export class AutomationReviews {
  constructor(rules, { adapter = runReviewAdapter, connected = () => false, coverage = async () => ({ fresh: false }), resolveJid = async (jid) => jid, transport, logger = console } = {}) {
    Object.assign(this, { rules, adapter, connected, coverage, resolveJid, transport, logger })
    this.job = null
    this.controller = new AbortController()
    this.stopping = false
  }

  async submit(batchId, runId, { text, reason, jid }) {
    if (!nonempty(text, 2000) || !nonempty(reason, 600) || !nonempty(jid, 160)) throw new Error('A draft requires text (1–2000), reason (1–600) and destination.')
    return this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId && b.runId === runId && b.status === 'running' && !b.report)
      if (!batch) throw new Error('Only the active executor may submit a draft before recording its result.')
      const rule = eligible(state, batch)
      if (batch.review || state.outbound.some((o) => o.batchId === batch.id)) throw new Error('This batch already has a draft or send attempt.')
      batch.review = { expiresAt: new Date(this.rules.now() + rule.review.expiresSeconds * 1000).toISOString(), nextPollAt: this.rules.nowIso(), revisions: [] }
      this.revise(batch, rule, { text, reason, jid })
      batch.report = { outcome: 'awaiting_review', summary: reason, at: this.rules.nowIso() }
      return { value: structuredClone(batch.review) }
    })
  }

  revise(batch, rule, { text, reason, jid }) {
    const revisions = batch.review.revisions
    revisions.push({ number: revisions.length + 1, key: `wa-${batch.id}-r${revisions.length + 1}`, parentId: revisions.at(-1)?.id || null, id: null, text: text.trim(), reason: reason.trim(), targetJid: jid, targetLabel: rule.destination, delivery: 'queued', createdAt: this.rules.nowIso(), cursor: 0, processedCursor: 0, events: [], decision: null })
    batch.review.nextPollAt = this.rules.nowIso()
  }

  async context(batchId) {
    const { batches, rules } = await this.rules.load()
    const batch = batches.find((b) => b.id === batchId)
    const policy = rules.find((r) => r.id === batch?.ruleId)?.review
    if (!batch?.review || !policy) throw new Error('This run has no draft review.')
    const revision = currentDraft(batch)
    return { actor: policy.actor, instructions: policy.instructions, reviewers: policy.reviewers, expiresAt: batch.review.expiresAt, maxRevisions: policy.maxRevisions, revision: { ...revision, events: undefined }, replies: latestReplies(revision.events).map((e) => ({ ...e, authorized: authorizedReply(policy, e) })), history: batch.review.revisions.slice(0, -1).map(({ number, id, text, reason, decision }) => ({ number, id, text, reason, decision })) }
  }

  // Interpretation is the model's job. These checks bind its decision to an
  // authorized person's current reply and the exact proposal they saw.
  async decide(batchId, runId, { action, revision: number, cursor, replyId, reason, text }) {
    if (!['approve', 'revise', 'cancel', 'wait'].includes(action) || !nonempty(reason, 600)) throw new Error('Use approve|revise|cancel|wait with a reason (1–600).')
    if (action === 'revise' && !nonempty(text, 2000)) throw new Error('A revision requires a new text (1–2000).')
    return this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId && b.runId === runId && b.status === 'reviewing')
      if (!batch) throw new Error('Only the active review interpreter can decide.')
      const rule = eligible(state, batch)
      const draft = currentDraft(batch)
      if (Date.parse(batch.review.expiresAt) <= this.rules.now()) throw new Error('This review expired.')
      if (draft.number !== number || draft.cursor !== cursor || cursor <= draft.processedCursor || batch.reviewAction) throw new Error('Read the latest revision and all replies before deciding.')
      const replies = latestReplies(draft.events)
      const evidence = replies.find((r) => r.id === replyId)
      if (action !== 'wait' && (!evidence || !authorizedReply(rule.review, evidence) || evidence.cursor <= draft.processedCursor)) throw new Error('Decision requires a new, current reply from an authorized reviewer.')
      if (action === 'approve' && replies.some((r) => authorizedReply(rule.review, r) && r.cursor > draft.processedCursor && r.audio && !r.transcript)) throw new Error('Untranscribed reviewer audio prevents approval. Wait for text or configure transcription.')
      const decision = { action, reason, replyId: evidence?.id || null, author: evidence?.author?.id || null, cursor, at: this.rules.nowIso() }
      draft.processedCursor = cursor
      draft.decision = decision
      if (action === 'revise' && batch.review.revisions.length >= rule.review.maxRevisions) { decision.action = 'cancel'; decision.reason = `Revision limit reached. ${reason}` }
      if (decision.action === 'revise') this.revise(batch, rule, { text, reason, jid: draft.targetJid })
      batch.reviewAction = decision
      return { value: structuredClone(decision) }
    })
  }

  tick() {
    if (this.stopping) return Promise.resolve()
    if (!this.job) {
      this.job = this.poll().catch((error) => this.logger.error({ err: error }, 'Draft review polling failed')).finally(() => { this.job = null })
    }
    return this.job
  }

  stop() { this.stopping = true; this.controller.abort() }

  async poll() {
    const { batches } = await this.rules.load()
    // Limit each sweep, rotate by persisted nextPollAt, and keep all I/O out
    // of the store lock. Waiting for humans never occupies a model slot.
    const due = batches.filter((b) => WAITING.has(b.status) && b.review && Date.parse(b.review.nextPollAt) <= this.rules.now()).sort((a, b) => Date.parse(a.review.nextPollAt) - Date.parse(b.review.nextPollAt)).slice(0, 10)
    const queue = [...due]
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && !this.stopping) await this.pollOne(queue.shift().id)
    }))
  }

  async pollOne(batchId) {
    if (this.stopping) return
    let snapshot = await this.rules.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId)
      if (!batch?.review || !WAITING.has(batch.status)) return { save: false }
      let rule
      try { rule = eligible(state, batch) } catch { return { save: false } }
      if (Date.parse(batch.review.expiresAt) <= this.rules.now()) {
        if (batch.status === 'reviewing') { batch.invalidated = 'Draft review expired.'; batch.invalidationKind = 'control' }
        else Object.assign(batch, { status: 'canceled', completedAt: this.rules.nowIso(), lastError: 'Draft review expired without sending.' })
        return {}
      }
      batch.review.nextPollAt = new Date(this.rules.now() + rule.review.pollSeconds * 1000).toISOString()
      const draft = currentDraft(batch)
      if (draft.delivery === 'publishing' || (draft.delivery === 'queued' && batch.status !== 'review_waiting')) return {}
      if (draft.delivery === 'queued') draft.delivery = 'publishing'
      return { value: { batch: structuredClone(batch), rule: structuredClone(rule) } }
    })
    if (!snapshot) return
    const { batch, rule } = snapshot
    const draft = currentDraft(batch)
    try {
      if (draft.delivery === 'publishing') {
        const result = await this.adapter(rule.review.adapter, { op: 'publish', draft: { key: draft.key, parentId: draft.parentId, revision: draft.number, target: { jid: draft.targetJid, label: draft.targetLabel }, text: draft.text, context: { automation: rule.name, actor: rule.review.actor, reason: draft.reason } } }, { signal: this.controller.signal })
        if (!result || result.status !== 'published' || !nonempty(result.id, 160)) throw new Error('Draft publication was not confirmed; inspect the adapter using the stored key.')
        await this.rules.mutate(async (state) => {
          const current = state.batches.find((b) => b.id === batchId)
          const revision = current?.review?.revisions.find((r) => r.key === draft.key)
          if (revision) Object.assign(revision, { id: result.id, messageId: result.messageId || null, delivery: 'published' })
          return {}
        })
        return
      }
      if (draft.delivery !== 'published') return
      // Drain every page before interpretation or delivery. A later edit can
      // revoke an apparent approval found on an earlier page.
      let after = draft.cursor; const events = []
      let exhausted = false
      for (let pages = 0; pages < 20; pages++) {
        const page = validateReplyPage(await this.adapter(rule.review.adapter, { op: 'replies', draftId: draft.id, after }, { signal: this.controller.signal }), draft.id, after)
        events.push(...page.replies); after = page.nextCursor
        if (page.replies.length < 50) { exhausted = true; break }
      }
      if (!exhausted || draft.events.length + events.length > 2000 || JSON.stringify([...draft.events, ...events]).length > 256000) throw new Error('Review reply limit reached; inspect the feed before continuing.')
      await this.rules.mutate(async (state) => {
        const current = state.batches.find((b) => b.id === batchId)
        if (!current || !WAITING.has(current.status) || currentDraft(current).key !== draft.key) return { save: false }
        eligible(state, current)
        const revision = currentDraft(current)
        // A single poller owns this cursor. Never overwrite a newer decision.
        if (revision.cursor !== draft.cursor) return { save: false }
        revision.events.push(...events); revision.cursor = after
        current.review.lastError = null
        if (events.some((e) => authorizedReply(rule.review, e))) {
          revision.decision = null
          if (current.status === 'reviewing') { current.invalidated = 'New reviewer replies arrived.'; current.invalidationKind = 'review_replies' }
          else current.status = 'review_ready'
        } else if (events.length) {
          // Unknown group members and bots do not spend model calls or revoke
          // an authorized decision. Keep their literal events in the audit.
          if (revision.decision) revision.decision.cursor = after
          if (revision.processedCursor === draft.cursor) revision.processedCursor = after
        }
        return {}
      })
      if (!events.some((e) => authorizedReply(rule.review, e))) await this.deliver(batchId)
    } catch (error) {
      await this.rules.mutate(async (state) => {
        const current = state.batches.find((b) => b.id === batchId)
        if (!current?.review) return { save: false }
        current.review.lastError = error.message
        if (draft.delivery === 'publishing') {
          const revision = current.review.revisions.find((r) => r.key === draft.key)
          if (revision) revision.delivery = 'delivery_unknown'
          if (WAITING.has(current.status)) Object.assign(current, { status: 'uncertain', completedAt: this.rules.nowIso(), lastError: 'Draft publication uncertain; inspect the stored key. Never create a replacement blindly.' })
        }
        return {}
      })
    }
  }

  async deliver(batchId) {
    const { batches, rules } = await this.rules.load()
    const batch = batches.find((b) => b.id === batchId)
    const draft = currentDraft(batch || {})
    if (batch?.status !== 'review_waiting' || draft?.decision?.action !== 'approve') return
    const rule = rules.find((r) => r.id === batch.ruleId)
    if (this.stopping || !this.connected() || !(await this.coverage(batch.sourceJid)).fresh) return
    if (await this.resolveJid(rule.destinationOriginalJid) !== draft.targetJid) throw new Error('Destination identity changed after review. Create a new reviewed proposal.')
    await this.rules.send({ batchId, reviewKey: draft.key, jid: draft.targetJid, text: draft.text },
      (messageId) => this.transport(draft.targetJid, draft.text, messageId),
      async () => !this.stopping && this.connected() && (await this.coverage(batch.sourceJid)).fresh)
  }

  async recover() {
    return this.rules.mutate(async (state) => {
      for (const batch of state.batches.filter((b) => b.review)) {
        const draft = currentDraft(batch)
        if (state.outbound.some((o) => o.batchId === batch.id && o.status !== 'accepted')) {
          Object.assign(batch, { status: 'uncertain', completedAt: this.rules.nowIso(), lastError: 'Interrupted reviewed delivery. Inspect the reserved WhatsApp ID; no automatic replay.' })
          const rule = state.rules.find((r) => r.id === batch.ruleId)
          if (rule) rule.humanHold = true
        } else if (draft.delivery === 'publishing') {
          draft.delivery = 'delivery_unknown'
          Object.assign(batch, { status: 'uncertain', completedAt: this.rules.nowIso(), lastError: 'Bridge stopped during draft publication. Inspect the stored key; no automatic replay.' })
        }
      }
      return {}
    })
  }
}
