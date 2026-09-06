import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AutomationStore, journal } from './automation-store.js'
import { validateHumanPolicy, withHumanDefaults, HUMAN_WAITING, validateStoredHuman, commitHumanDecision } from './human-policy.js'
import { authorizedReply, latestReplies, validateReviewPolicy, validateStoredReview, withReviewDefaults } from './review-adapter.js'

const VERSION = 4
const RULE_STATUSES = new Set(['active', 'paused', 'removed'])
const ACTIVE = new Set(['judging', 'running', 'reviewing', 'clarifying'])
const BATCH_STATUSES = new Set(['pending', 'judging', 'running', 'waiting', 'review_waiting', 'review_ready', 'reviewing', 'completed', 'uncertain', 'failed', 'human', 'ignored', 'observed', 'canceled', 'superseded', 'human_waiting', 'human_ready', 'clarifying', 'human_ack', 'human_resume', 'human_frozen'])
const DIRECTIONS = new Set(['incoming', 'from-me', 'any'])
const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// Transport/control frames sometimes appear as mirrored messages. They are not
// user-authored content and must never spend an automation provider call.
const USER_CONTENT_TYPES = new Set([
  'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
  'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage',
  'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
  'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3',
])

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
function id() { return crypto.randomUUID().replaceAll('-', '') }
function text(value) { return typeof value === 'string' && value.trim().length > 0 }
function validName(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value) }
function validTarget(value) { return text(value) && !value.startsWith('-') && value.length <= 160 }

function sourceKeys(rule) {
  return new Set([rule.sourceJid, rule.sourceOriginalJid].filter(text))
}

function directionMatches(rule, message) {
  return rule.direction === 'any'
    || (rule.direction === 'from-me' && message.fromMe)
    || (rule.direction === 'incoming' && !message.fromMe)
}

function validRule(rule) {
  return rule && typeof rule === 'object' && typeof rule.id === 'string' && validName(rule.name)
    && [rule.source, rule.sourceTarget, rule.sourceJid, rule.sourceOriginalJid, rule.destination, rule.destinationTarget, rule.destinationJid, rule.destinationOriginalJid, rule.profile].every(text)
    && RULE_STATUSES.has(rule.status) && DIRECTIONS.has(rule.direction) && Number.isInteger(rule.activeAfter)
    && Number.isInteger(rule.debounceSeconds) && rule.debounceSeconds >= 0 && rule.debounceSeconds <= 3600
    && typeof rule.createdAt === 'string' && typeof rule.updatedAt === 'string'
}

function validBatch(batch) {
  return batch && typeof batch === 'object' && typeof batch.id === 'string' && typeof batch.ruleId === 'string' && validName(batch.ruleName)
    && text(batch.sourceJid) && Array.isArray(batch.messageIds) && (batch.messageIds.length > 0 || text(batch.trigger?.key)) && batch.messageIds.every(text)
    && BATCH_STATUSES.has(batch.status) && typeof batch.createdAt === 'string' && typeof batch.dueAt === 'string'
    && (batch.completedAt === null || typeof batch.completedAt === 'string')
    && (batch.lastError === null || typeof batch.lastError === 'string')
    && (batch.output === null || typeof batch.output === 'string')
}

function defaults(rule) {
  return {
    mode: 'live', judgeProfile: null, review: null, humanConsultation: null, trigger: 'messages', maxWaitSeconds: Math.min(3600, Math.max(60, rule.debounceSeconds * 3)),
    maxBatchMessages: 100, humanTakeover: false, humanHold: false, maxRepliesPerHour: 20,
    ...rule,
    ...(rule.sourceJid?.endsWith('@g.us') ? { sourceOriginalJid: rule.sourceJid } : {}),
    ...(rule.destinationJid?.endsWith('@g.us') ? { destinationOriginalJid: rule.destinationJid } : {}),
  }
}

function normalize(value) {
  if (!value || ![1, 2, 3, VERSION].includes(value.version) || !Array.isArray(value.rules) || !Array.isArray(value.batches)
    || value.rules.some((rule) => !validRule(rule)) || value.batches.some((batch) => !validBatch(batch))) {
    throw new Error('Prompt automation state is malformed. It was left unchanged; inspect the private state before enabling or editing a rule.')
  }
  const rules = value.rules.map((rule) => defaults({ reconcileAfter: value.version === 1 ? Math.floor(Date.now() / 1000) : rule.activeAfter, ...rule }))
  for (const rule of rules) validateOptions(rule)
  for (const batch of value.batches) {
    validateStoredReview(batch)
    validateStoredHuman(batch, rules.find((r) => r.id === batch.ruleId)?.humanConsultation)
    if (batch.review && !rules.find((rule) => rule.id === batch.ruleId)?.review) throw new Error('Draft batch has no review policy.')
  }
  if (value.outbound !== undefined && (!Array.isArray(value.outbound) || value.outbound.some((entry) => !text(entry.messageId) || !text(entry.batchId) || !text(entry.jid) || !text(entry.fingerprint) || !['sending', 'accepted', 'uncertain'].includes(entry.status) || !Number.isFinite(Date.parse(entry.createdAt))))) throw new Error('Malformed automation outbound audit.')
  return { version: VERSION, rules, batches: value.batches, outbound: value.outbound || [] }
}

function validateOptions(rule) {
  validateReviewPolicy(rule.review)
  validateHumanPolicy(rule.humanConsultation ?? null)
  if (!['messages', 'manual'].includes(rule.trigger)) throw new Error('Trigger must be messages or manual.')
  if (!['live', 'observe'].includes(rule.mode)) throw new Error('Mode must be live or observe.')
  if (rule.judgeProfile !== null && !validName(rule.judgeProfile)) throw new Error('Invalid judge profile.')
  if (!Number.isInteger(rule.maxWaitSeconds) || rule.maxWaitSeconds < rule.debounceSeconds || rule.maxWaitSeconds > 3600) throw new Error('Max wait must be at least the debounce and at most 3600 seconds.')
  if (!Number.isInteger(rule.maxBatchMessages) || rule.maxBatchMessages < 1 || rule.maxBatchMessages > 500) throw new Error('Max batch messages must be 1 to 500.')
  if (typeof rule.humanTakeover !== 'boolean' || typeof rule.humanHold !== 'boolean') throw new Error('Human control must be boolean.')
  if (!Number.isInteger(rule.maxRepliesPerHour) || rule.maxRepliesPerHour < 1 || rule.maxRepliesPerHour > 100) throw new Error('Max replies per hour must be 1 to 100.')
}

function finish(batch, status, now, detail = null) {
  Object.assign(batch, { status, completedAt: now, lastError: detail })
}

function invalidate(state, ruleId, now, reason, { pendingStatus = 'canceled' } = {}) {
  for (const batch of state.batches.filter((item) => item.ruleId === ruleId)) {
    if (ACTIVE.has(batch.status)) { batch.invalidated = reason; batch.invalidationKind = 'control' }
    else if (HUMAN_WAITING.has(batch.status)) { batch.status = 'human_frozen'; batch.lastError = reason }
    if (['pending', 'waiting', 'review_waiting', 'review_ready'].includes(batch.status)) finish(batch, pendingStatus, now, reason)
  }
}

function activeBatch(state, batchId, runId) {
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch || !ACTIVE.has(batch.status) || batch.runId !== runId) throw new Error('This automation run is no longer active.')
  const rule = state.rules.find((item) => item.id === batch.ruleId)
  if (!rule || (rule.status !== 'active' && !batch.observe) || (rule.humanHold && !batch.observe) || batch.invalidated) throw new Error('Automation paused, taken over by a human, or superseded by new messages.')
  return { batch, rule }
}


export class PromptAutomationRules {
  constructor(filename, { now = () => Date.now(), lockRetryMs = 25, lockTimeoutMs = 5000, staleLockMs = 60 * 1000 } = {}) {
    this.filename = filename
    this.store = new AutomationStore(filename)
    this.lockFilename = `${filename}.lock`
    this.now = now
    this.lockRetryMs = lockRetryMs
    this.lockTimeoutMs = lockTimeoutMs
    this.staleLockMs = staleLockMs
  }

  nowIso() { return new Date(this.now()).toISOString() }
  nowSeconds() { return Math.floor(this.now() / 1000) }

  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8'))
      if (value.storage === 'sqlite' && value.version === VERSION) {
        await fs.access(this.store.filename)
        return normalize(await this.store.load())
      }
      return normalize(value)
    } catch (error) {
      if (error.code === 'ENOENT' && error.path === this.filename) return { version: VERSION, rules: [], batches: [], outbound: [] }
      if (error instanceof SyntaxError) throw new Error('Prompt automation state could not be parsed. It was left unchanged; inspect private state.')
      throw error
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    let migrated = false
    try { migrated = JSON.parse(await fs.readFile(this.filename, 'utf8')).storage === 'sqlite' } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!migrated) {
      try { await fs.copyFile(this.filename, `${this.filename}.pre-sqlite`, fs.constants.COPYFILE_EXCL); await fs.chmod(`${this.filename}.pre-sqlite`, 0o600) }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error }
    }
    const cutoff = this.now() - DEDUP_RETENTION_MS
    state.version = VERSION
    state.batches = state.batches.filter((b) => b.human || b.trigger || !['completed', 'ignored', 'observed', 'canceled', 'superseded'].includes(b.status) || Date.parse(b.completedAt || b.createdAt) >= cutoff)
    state.outbound = state.outbound.filter((e) => e.status !== 'accepted' || Date.parse(e.createdAt) >= cutoff || state.batches.some((b) => b.id === e.batchId && b.human))
    await this.store.save(state)
    if (!migrated) {
      const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: VERSION, storage: 'sqlite' }) + '\n'); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, this.filename)
      const directory = await fs.open(path.dirname(this.filename), 'r'); try { await directory.sync() } finally { await directory.close() }
    }
  }

  async withLock(work) {
    const deadline = Date.now() + this.lockTimeoutMs
    let handle = null
    while (!handle) {
      try {
        await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
        handle = await fs.open(this.lockFilename, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid }))
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        // Serialize stale-owner inspection. Re-read the current owner under
        // the recovery lock so concurrent processes cannot delete a new lock.
        let recovery = null
        try {
          recovery = await fs.open(`${this.lockFilename}.recovery`, 'wx', 0o600)
          const owner = JSON.parse(await fs.readFile(this.lockFilename, 'utf8'))
          if (Number.isInteger(owner.pid)) {
            try { process.kill(owner.pid, 0) } catch (probe) {
              if (probe.code === 'ESRCH') await fs.rm(this.lockFilename, { force: true })
            }
          }
        } catch (statError) {
          if (!['ENOENT', 'EEXIST'].includes(statError.code) && !(statError instanceof SyntaxError)) throw statError
        } finally {
          if (recovery) {
            await recovery.close()
            await fs.rm(`${this.lockFilename}.recovery`, { force: true })
          }
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for prompt automations. Retry the command.')
        await wait(this.lockRetryMs)
      }
    }
    try { return await work() } finally {
      await handle.close().catch(() => {})
      await fs.rm(this.lockFilename, { force: true }).catch(() => {})
    }
  }

  async mutate(work) {
    return this.withLock(async () => {
      const state = await this.load()
      const result = await work(state)
      if (result?.save !== false) await this.save(state)
      return result?.value
    })
  }

  async add({
    name, source, sourceTarget, sourceJid, sourceOriginalJid = null,
    destination, destinationTarget, destinationJid, destinationOriginalJid = null,
    profile, direction = 'incoming', debounceSeconds = 300,
    mode = 'live', judgeProfile = null, review = null, humanConsultation = null, trigger = 'messages', maxWaitSeconds = Math.min(3600, Math.max(60, debounceSeconds * 3)),
    maxBatchMessages = 100, humanTakeover = false, maxRepliesPerHour = 20, status = 'active',
  }) {
    review = withReviewDefaults(review)
    humanConsultation = withHumanDefaults(humanConsultation)
    if (!validName(name) || ![source, sourceJid, destination, destinationJid, profile].every(text) || ![sourceTarget, destinationTarget].every(validTarget)) {
      throw new Error('A rule name, source, destination, CLI targets, and AI profile are required.')
    }
    if (!DIRECTIONS.has(direction)) throw new Error('Prompt automation direction must be incoming, from-me, or any.')
    if (!Number.isInteger(debounceSeconds) || debounceSeconds < 0 || debounceSeconds > 3600) throw new Error('Debounce must be between 0 seconds and 1 hour.')
    return this.mutate(async (state) => {
      if (state.rules.some((rule) => rule.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error(`A prompt automation named ${name} already exists, including removed history.`)
      const rule = {
        id: id(), name, source: source.trim(), sourceTarget: sourceTarget.trim(), sourceJid: sourceJid.trim(), sourceOriginalJid: sourceOriginalJid?.trim() || sourceJid.trim(),
        destination: destination.trim(), destinationTarget: destinationTarget.trim(), destinationJid: destinationJid.trim(), destinationOriginalJid: destinationOriginalJid?.trim() || destinationJid.trim(),
        profile: profile.trim(), direction, debounceSeconds, mode, judgeProfile, review, humanConsultation, trigger, maxWaitSeconds, maxBatchMessages, humanTakeover, humanHold: false, maxRepliesPerHour, status, reconcileAfter: this.nowSeconds(), activeAfter: this.nowSeconds(), createdAt: this.nowIso(), updatedAt: this.nowIso(),
      }
      validateOptions(rule)
      if (!['active', 'paused'].includes(status)) throw new Error('New rules must be active or paused.')
      state.rules.push(rule)
      return { value: structuredClone(rule) }
    })
  }

  async list({ all = false } = {}) { return (await this.load()).rules.filter((rule) => all || rule.status !== 'removed').map((rule) => structuredClone(rule)) }
  async get(name) { const rule = [...(await this.load()).rules].reverse().find((entry) => entry.name === name); return rule ? structuredClone(rule) : null }
  async getById(id) { const rule = (await this.load()).rules.find((entry) => entry.id === id); return rule ? structuredClone(rule) : null }
  async batchesFor(ruleId) { return (await this.load()).batches.filter((batch) => batch.ruleId === ruleId).map((batch) => structuredClone(batch)) }

  async setHumanPolicy(name, policy) {
    policy = withHumanDefaults(policy); validateHumanPolicy(policy)
    return this.mutate(async (state) => {
      const rule = state.rules.find((r) => r.name === name && r.status !== 'removed')
      if (!rule) throw new Error('Unknown rule.')
      if (state.batches.some((b) => b.ruleId === rule.id && (ACTIVE.has(b.status) || HUMAN_WAITING.has(b.status)))) throw new Error('Finish or cancel existing work before changing consultation policy.')
      rule.humanConsultation = policy; rule.updatedAt = this.nowIso()
      return { value: structuredClone(rule) }
    })
  }

  async resumeHuman(batchId) {
    return this.mutate(async (state) => {
      const b = state.batches.find((b) => b.id === batchId && b.status === 'human_frozen')
      const rule = state.rules.find((r) => r.id === b?.ruleId)
      if (!b || rule?.status !== 'active' || rule.humanHold) throw new Error('Activate the rule and inspect frozen work first.')
      if (b.human.post.delivery === 'delivery_unknown' || b.human.post.delivery === 'publishing') throw new Error('Resolve uncertain publication by its stable key before resuming.')
      Object.assign(b, { status: b.human.cursor > b.human.processedCursor ? 'human_ready' : 'human_waiting', invalidated: null, invalidationKind: null, lastError: null })
      b.human.decision = null; b.human.nextPollAt = this.nowIso()
      return { value: structuredClone(b) }
    })
  }

  async setReviewExpiry(name, expiresSeconds) {
    return this.mutate(async (state) => {
      const rule = state.rules.find((item) => item.name === name)
      if (!rule?.review || rule.status === 'removed') throw new Error('An existing rule with draft review is required.')
      const review = { ...rule.review, expiresSeconds }
      validateReviewPolicy(review)
      rule.review = review
      rule.updatedAt = this.nowIso()
      let pendingUpdated = 0
      for (const batch of state.batches.filter((b) => b.ruleId === rule.id && b.review && ['running', 'review_waiting', 'review_ready', 'reviewing'].includes(b.status))) {
        // Never revive expired or terminal drafts. Keep the original start;
        // changing the duration does not grant a fresh full window from now.
        if (batch.invalidated || Date.parse(batch.review.expiresAt) <= this.now()) continue
        batch.review.expiresAt = new Date(Date.parse(batch.review.revisions[0].createdAt) + expiresSeconds * 1000).toISOString()
        pendingUpdated++
      }
      return { value: { name: rule.name, status: rule.status, expiresSeconds, pendingUpdated } }
    })
  }

  async setStatus(name, status) {
    if (!RULE_STATUSES.has(status)) throw new Error('Invalid prompt automation status.')
    return this.mutate(async (state) => {
      const rule = state.rules.find((item) => item.name === name)
      if (!rule || rule.status === 'removed') throw new Error(`Unknown or removed prompt automation: ${name}`)
      rule.status = status
      rule.updatedAt = this.nowIso()
      if (status === 'active') rule.activeAfter = this.nowSeconds()
      else invalidate(state, rule.id, this.nowIso(), `Rule ${status}; no further sends are allowed.`)
      return { value: structuredClone(rule) }
    })
  }

  async setMode(name, mode) {
    if (!['observe', 'live'].includes(mode)) throw new Error('Mode must be observe or live.')
    return this.mutate(async (state) => {
      const rule = state.rules.find((item) => item.name === name && item.status !== 'removed')
      if (!rule) throw new Error('Unknown rule.')
      invalidate(state, rule.id, this.nowIso(), 'Automation mode changed.')
      rule.mode = mode
      rule.activeAfter = this.nowSeconds()
      rule.updatedAt = this.nowIso()
      return { value: structuredClone(rule) }
    })
  }

  async setHuman(name, hold) {
    return this.mutate(async (state) => {
      const rule = state.rules.find((item) => item.name === name && item.status !== 'removed')
      if (!rule) throw new Error(`Unknown prompt automation: ${name}`)
      if (!hold && state.batches.some((batch) => batch.ruleId === rule.id && batch.status === 'uncertain' && !batch.reviewedAt)) throw new Error('Review uncertain batches before releasing human control.')
      rule.humanHold = hold
      rule.updatedAt = this.nowIso()
      if (hold) invalidate(state, rule.id, this.nowIso(), 'Human takeover.', { pendingStatus: 'human' })
      // Releasing control starts with future messages; old human decisions are
      // retained for review, never silently replayed.
      else rule.activeAfter = this.nowSeconds()
      return { value: structuredClone(rule) }
    })
  }

  async enqueue(message, { resolveSourceJid = async (jid) => jid } = {}) {
    return this.mutate(async (state) => {
      const timestamp = Number(message?.timestamp)
      if (message?.source !== 'live' || !text(message?.jid) || !text(message?.id) || !USER_CONTENT_TYPES.has(message?.type) || !Number.isFinite(timestamp)) return { value: [], save: false }
      if (state.outbound.some((entry) => entry.messageId === message.id && entry.jid === message.jid)) return { value: [], save: false }
      const matched = []
      let changed = false
      for (const rule of state.rules.filter((entry) => entry.status === 'active')) {
        const resolved = await resolveSourceJid(rule.sourceOriginalJid)
        if (!(sourceKeys(rule).has(message.jid) || resolved === message.jid) || timestamp < rule.activeAfter) continue
        if (state.batches.some((batch) => batch.ruleId === rule.id && batch.messageIds.includes(message.id))) continue
        const manualBatch = rule.trigger === 'manual' ? state.batches.find((b) => b.ruleId === rule.id && (ACTIVE.has(b.status) || HUMAN_WAITING.has(b.status) || ['pending', 'waiting', 'review_waiting', 'review_ready'].includes(b.status)) && timestamp >= Math.floor(Date.parse(b.createdAt) / 1000)) : null
        if (rule.trigger === 'manual' && !manualBatch) continue
        if (manualBatch) { manualBatch.messageIds.push(message.id); changed = true }
        if (message.fromMe && rule.humanTakeover) {
          rule.humanHold = true
          invalidate(state, rule.id, this.nowIso(), 'Account owner replied.', { pendingStatus: 'human' })
          changed = true
        }
        if (!directionMatches(rule, message)) continue
        const consulting = state.batches.find((b) => b.ruleId === rule.id && (HUMAN_WAITING.has(b.status) || (b.status === 'running' && b.report?.outcome === 'awaiting_human')))
        if (consulting) {
          if (!consulting.messageIds.includes(message.id)) consulting.messageIds.push(message.id)
          consulting.sourceEpoch = (consulting.sourceEpoch || 0) + 1
          journal(state, consulting.id, `source-${consulting.id}-${message.id}`, 'source', message)
          if (consulting.status === 'clarifying') { consulting.invalidated = 'Source changed during consultation'; consulting.invalidationKind = 'human_replies' }
          else if (['human_ack', 'human_resume'].includes(consulting.status)) {
            // Re-read the evidence behind an acknowledged continuation if
            // source facts changed before execution. No new human reply is
            // needed merely to notice that the old answer is now insufficient.
            consulting.human.processedCursor = Math.min(consulting.human.processedCursor, consulting.human.decision?.inputCursor ?? consulting.human.processedCursor)
            consulting.status = 'human_ready'; consulting.human.decision = null; consulting.human.resolved = false
          }
          matched.push(structuredClone(consulting)); changed = true; continue
        }
        for (const waiting of state.batches.filter((batch) => batch.ruleId === rule.id && ['waiting', 'review_waiting', 'review_ready'].includes(batch.status))) { finish(waiting, 'superseded', this.nowIso(), 'New incoming messages supersede the pending follow-up or draft.'); changed = true }
        // A message arriving during generation invalidates that response. The
        // job can finish recording its work; the next job sees this report.
        for (const running of state.batches.filter((batch) => batch.ruleId === rule.id && ACTIVE.has(batch.status))) { running.invalidated = 'New messages arrived during this run.'; running.invalidationKind = 'new_messages'; changed = true }
        if (rule.trigger === 'manual') { if (manualBatch.status === 'pending') finish(manualBatch, 'superseded', this.nowIso(), 'New source messages arrived before the explicit trigger ran.'); continue }
        let batch = state.batches.find((entry) => entry.ruleId === rule.id && entry.status === 'pending' && entry.messageIds.length < rule.maxBatchMessages)
        if (!batch) {
          batch = { id: id(), ruleId: rule.id, ruleName: rule.name, sourceJid: message.jid, messageIds: [], status: rule.humanHold ? 'human' : 'pending', createdAt: this.nowIso(), dueAt: this.nowIso(), completedAt: rule.humanHold ? this.nowIso() : null, lastError: null, output: null }
          state.batches.push(batch)
        }
        batch.decision = null
        batch.messageIds.push(message.id)
        const maxDue = Date.parse(batch.createdAt) + rule.maxWaitSeconds * 1000
        batch.dueAt = new Date(batch.messageIds.length >= rule.maxBatchMessages ? this.now() : Math.min(this.now() + rule.debounceSeconds * 1000, maxDue)).toISOString()
        matched.push(structuredClone(batch))
        changed = true
      }
      return { value: matched, save: changed }
    })
  }

  async reconcile(messages, { resolveSourceJid = async (jid) => jid } = {}) {
    const state = await this.load()
    const rules = await Promise.all(state.rules.filter((rule) => rule.status === 'active').map(async (rule) => ({ ...rule, currentJid: await resolveSourceJid(rule.sourceOriginalJid), manualAfter: rule.trigger === 'manual' ? Math.min(...state.batches.filter((b) => b.ruleId === rule.id && (ACTIVE.has(b.status) || HUMAN_WAITING.has(b.status) || ['pending', 'waiting', 'review_waiting', 'review_ready'].includes(b.status))).map((b) => Math.floor(Date.parse(b.createdAt) / 1000))) : 0 })))
    const seen = new Map(rules.map((rule) => [rule.id, new Set(state.batches.filter((batch) => batch.ruleId === rule.id).flatMap((batch) => batch.messageIds))]))
    const own = new Set(state.outbound.map((entry) => `${entry.jid}:${entry.messageId}`))
    const candidates = messages.filter((message) => message.source === 'live' && USER_CONTENT_TYPES.has(message.type) && !own.has(`${message.jid}:${message.id}`) && rules.some((rule) => [rule.sourceJid, rule.sourceOriginalJid, rule.currentJid].includes(message.jid) && message.timestamp >= Math.max(rule.activeAfter, rule.reconcileAfter || 0, rule.manualAfter) && !seen.get(rule.id).has(message.id) && (directionMatches(rule, message) || (message.fromMe && rule.humanTakeover && !rule.humanHold))))
    for (const message of candidates.sort((a, b) => a.timestamp - b.timestamp)) await this.enqueue(message, { resolveSourceJid })
    return candidates.length
  }

  async claimDue({ workspaces = {}, maxConcurrent = 3, connected = true } = {}) {
    return this.mutate(async (state) => {
      const running = state.batches.filter((item) => ACTIVE.has(item.status))
      const workspaceHolds = state.batches.filter((item) => (item.status === 'uncertain' && item.workspaceLock && !item.reviewedAt) || HUMAN_WAITING.has(item.status))
      if (running.length >= maxConcurrent) return { value: null, save: false }
      const candidates = state.batches.filter((entry) => ['pending', 'waiting', 'review_ready', 'human_ready', 'human_resume'].includes(entry.status) && Date.parse(entry.dueAt) <= this.now()).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      for (const batch of candidates) {
        const rule = state.rules.find((item) => item.id === batch.ruleId)
        if (!rule || rule.status === 'removed' || (!batch.observe && (rule.status !== 'active' || rule.humanHold))) continue
        if (!connected && batch.status !== 'human_ready') continue
        if (['human_ready', 'human_resume'].includes(batch.status) && ['publishing', 'delivery_unknown'].includes(batch.human.post.delivery)) continue
        if (batch.status === 'human_ready' && (!batch.human.caughtUp || Date.parse(batch.human.replyDueAt || batch.dueAt) > this.now())) continue
        const keys = new Set([rule.sourceJid, rule.sourceOriginalJid, rule.destinationJid, rule.destinationOriginalJid, batch.sourceJid])
        const proposedWorkspace = ['review_ready', 'human_ready'].includes(batch.status) ? null : workspaces[rule.profile] || null
        const overlaps = (other) => proposedWorkspace && other && (proposedWorkspace === other || proposedWorkspace.startsWith(`${other}${path.sep}`) || other.startsWith(`${proposedWorkspace}${path.sep}`))
        if (workspaceHolds.some((item) => item.id !== batch.id && (overlaps(item.reservedWorkspace || item.workspaceLock) || item.ruleId === batch.ruleId || [item.sourceJid, state.rules.find((r) => r.id === item.ruleId)?.destinationJid].some((key) => keys.has(key))))) continue
        const busy = running.some((other) => {
          const otherRule = state.rules.find((item) => item.id === other.ruleId)
          return other.ruleId === rule.id || [other.sourceJid, otherRule?.sourceJid, otherRule?.sourceOriginalJid, otherRule?.destinationJid, otherRule?.destinationOriginalJid].some((key) => keys.has(key))
            || overlaps(other.workspaceLock || workspaces[otherRule?.profile])
        })
        if (busy) continue
        Object.assign(batch, { status: batch.status === 'human_ready' ? 'clarifying' : batch.status === 'review_ready' ? 'reviewing' : rule.judgeProfile && !batch.decision ? 'judging' : 'running', runId: id(), workspaceLock: proposedWorkspace, startedAt: this.nowIso(), attempt: (batch.attempt || 0) + 1, invalidated: null, invalidationKind: null, report: null, reviewAction: null })
        if (batch.status === 'running') batch.reservedWorkspace = proposedWorkspace
        if (batch.status === 'clarifying') { batch.human.readCursor = batch.human.processedCursor; batch.human.sourceReadCursor = 0; batch.human.sourceReadEpoch = null; batch.human.decision = null }
        return { value: structuredClone(batch) }
      }
      return { value: null, save: false }
    })
  }

  async defer(batchId, seconds = 15) {
    return this.transition(batchId, (batch) => {
      if (batch.invalidated) { if (batch.human) batch.status = 'human_frozen'; else finish(batch, 'canceled', this.nowIso(), batch.invalidated); return }
      Object.assign(batch, { status: batch.status === 'clarifying' ? 'human_ready' : batch.status === 'reviewing' ? 'review_ready' : batch.human?.resolved ? 'human_resume' : 'pending', dueAt: new Date(this.now() + seconds * 1000).toISOString() })
    })
  }

  async decide(batchId, runId, route, reason) {
    if (!['ai', 'human', 'none'].includes(route) || !text(reason) || reason.length > 2000) throw new Error('Use decision ai, human or none and a reason (1–2000 characters).')
    return this.mutate(async (state) => {
      const { batch } = activeBatch(state, batchId, runId)
      if (batch.status !== 'judging' || batch.decision) throw new Error('Only the active judge can record one decision.')
      batch.decision = { route, reason, at: this.nowIso() }
      return { value: structuredClone(batch.decision) }
    })
  }

  async trigger(name, key, reason, sourceJid) {
    if (!text(key) || key.length > 160 || !text(reason) || reason.length > 4000) throw new Error('Trigger requires a stable key (1–160) and reason (1–4000).')
    return this.mutate(async (state) => {
      const rule = state.rules.find((r) => r.name === name)
      if (!rule || rule.trigger !== 'manual') throw new Error('Explicit triggers require a manual rule.')
      const previous = state.batches.find((b) => b.ruleId === rule.id && b.trigger?.key === key)
      if (previous) {
        if (previous.trigger.reason !== reason) throw new Error('Trigger key already exists with different content.')
        return { value: structuredClone(previous), save: false }
      }
      if (rule.status !== 'active' || rule.humanHold) throw new Error('Activate/release the rule before triggering it.')
      if (state.batches.some((b) => b.ruleId === rule.id && (ACTIVE.has(b.status) || HUMAN_WAITING.has(b.status) || ['pending', 'waiting', 'review_waiting', 'review_ready', 'uncertain'].includes(b.status)))) throw new Error('This rule already has pending or uncertain work; inspect it before starting another trigger.')
      const batch = { id: id(), ruleId: rule.id, ruleName: name, sourceJid, messageIds: [], trigger: { key, reason }, status: 'pending', createdAt: this.nowIso(), dueAt: this.nowIso(), completedAt: null, lastError: null, output: null }
      state.batches.push(batch)
      return { value: structuredClone(batch) }
    })
  }

  async report(batchId, runId, outcome, summary, resumeAfter = null) {
    if (!['resolved', 'no_reply', 'needs_human', 'waiting'].includes(outcome) || !text(summary) || summary.length > 4000) throw new Error('A valid outcome and summary (1–4000 characters) are required.')
    if (outcome === 'waiting' && (!Number.isInteger(resumeAfter) || resumeAfter < 10 || resumeAfter > 86400)) throw new Error('Waiting requires --resume-after between 10 and 86400 seconds.')
    return this.mutate(async (state) => {
      const batch = state.batches.find((item) => item.id === batchId && item.runId === runId && ACTIVE.has(item.status))
      if (!batch || batch.status !== 'running' || batch.report) throw new Error('Only the active executor can record one result.')
      // Even an invalidated run may document partial work. It still cannot send.
      batch.report = { outcome, summary, resumeAfter, at: this.nowIso() }
      return { value: structuredClone(batch.report) }
    })
  }

  async finishRun(batchId, result, { stage = 'execute', workspace = false } = {}) {
    return this.mutate(async (state) => {
      const batch = state.batches.find((item) => item.id === batchId && ACTIVE.has(item.status))
      if (!batch) return { value: null, save: false }
      const rule = state.rules.find((item) => item.id === batch.ruleId)
      batch.output = String(result.output || '').slice(0, 8000)
      if (result.session) { batch.providerSessions ||= {}; batch.providerSessions[stage] = result.session; journal(state, batch.id, `provider-${batch.runId}`, 'provider-session', { ...result.session, stage, nativeDeferred: Boolean(result.nativeQuestion), at: this.nowIso() }) }
      const sends = state.outbound.filter((entry) => entry.batchId === batch.id)
      batch.sendCount = sends.filter((entry) => entry.status === 'accepted').length
      batch.summary = batch.report?.summary || batch.summary || null
      if (stage === 'review' && (!batch.invalidated || batch.invalidationKind === 'review_replies')) {
        if (batch.invalidationKind === 'review_replies') Object.assign(batch, { status: 'review_ready', invalidated: null, invalidationKind: null, reviewAction: null })
        else if (!batch.reviewAction) finish(batch, 'failed', this.nowIso(), result.error || 'Review interpreter exited without recording a decision.')
        else if (batch.reviewAction.action === 'cancel') finish(batch, 'canceled', this.nowIso(), batch.reviewAction.reason)
        else { batch.status = 'review_waiting'; batch.review.nextPollAt = this.nowIso() }
      } else if (!result.ok && batch.invalidated && !workspace && !sends.length) {
        finish(batch, 'superseded', this.nowIso(), batch.invalidated)
      } else if (!result.ok) {
        const uncertain = stage === 'execute' && (workspace || sends.length > 0)
        finish(batch, uncertain ? 'uncertain' : 'failed', this.nowIso(), result.error || 'Provider failed.')
        if (uncertain) { rule.humanHold = true; invalidate(state, rule.id, this.nowIso(), 'Uncertain work requires review.', { pendingStatus: 'human' }) }
      } else if (sends.some((entry) => entry.status !== 'accepted')) {
        finish(batch, 'uncertain', this.nowIso(), 'A send was started without a confirmed transport result.')
        rule.humanHold = true
        invalidate(state, rule.id, this.nowIso(), 'Uncertain send requires review.', { pendingStatus: 'human' })
      } else if (batch.invalidated) {
        finish(batch, 'superseded', this.nowIso(), batch.invalidated)
      } else if (stage === 'judge') {
        if (!batch.decision) finish(batch, 'failed', this.nowIso(), 'Judge exited without recording a decision.')
        else if (batch.decision.route === 'ai') Object.assign(batch, { status: 'pending', dueAt: this.nowIso() })
        else {
          finish(batch, batch.decision.route === 'human' ? 'human' : 'ignored', this.nowIso())
          if (batch.decision.route === 'human' && !batch.observe && rule.mode === 'live') {
            rule.humanHold = true
            invalidate(state, rule.id, this.nowIso(), 'Judge requested human control.', { pendingStatus: 'human' })
          }
        }
      } else if (!batch.report) {
        finish(batch, 'failed', this.nowIso(), 'Agent exited without recording an outcome. Inspect its audit; completion is not proof of resolution.')
      } else if (rule.mode === 'observe' || batch.observe) {
        finish(batch, 'observed', this.nowIso())
      } else if (batch.report.outcome === 'awaiting_human') {
        batch.status = 'human_waiting'
        if (result.nativeQuestion) batch.human.nativeQuestion = result.nativeQuestion
      } else if (batch.report.outcome === 'awaiting_review') {
        batch.status = 'review_waiting'
      } else if (batch.report.outcome === 'waiting') {
        Object.assign(batch, { status: 'waiting', dueAt: new Date(this.now() + batch.report.resumeAfter * 1000).toISOString() })
      } else if (batch.report.outcome === 'needs_human') {
        finish(batch, 'human', this.nowIso())
        rule.humanHold = true
        invalidate(state, rule.id, this.nowIso(), 'Executor requested human control.', { pendingStatus: 'human' })
      } else finish(batch, 'completed', this.nowIso())
      return { value: structuredClone(batch) }
    })
  }

  async context(ruleId) {
    const state = await this.load()
    return state.batches.filter((item) => item.ruleId === ruleId && (item.summary || item.decision || item.lastError)).slice(-20).map(({ id, status, messageIds, summary, decision, lastError, sendCount, createdAt }) => ({ id, status, messageIds, summary, decision, lastError, sendCount, createdAt }))
  }

  async assertRun(batchId, runId) { return activeBatch(await this.load(), batchId, runId) }

  async review(batchId, summary) {
    if (!text(summary) || summary.length > 4000) throw new Error('Review requires a factual summary (1–4000 characters).')
    return this.mutate(async (state) => {
      const batch = state.batches.find((item) => item.id === batchId && item.status === 'uncertain')
      if (!batch) throw new Error('Only uncertain batches require manual review.')
      batch.reviewedAt = this.nowIso()
      batch.reviewSummary = summary
      return { value: structuredClone(batch) }
    })
  }

  async cancel(batchId, reason) {
    if (!text(reason) || reason.length > 1000) throw new Error('Cancellation requires a reason (1–1000).')
    return this.mutate(async (state) => {
      const batch = state.batches.find((b) => b.id === batchId)
      if (!batch) throw new Error('Unknown batch.')
      if (batch.status === 'completed' || batch.sendCount) throw new Error('A completed send cannot be canceled.')
      if (batch.status === 'uncertain' && !batch.reviewedAt) throw new Error('Inspect and record a factual review of uncertain work before canceling.')
      if (ACTIVE.has(batch.status)) { batch.invalidated = `Operator canceled: ${reason}`; batch.invalidationKind = 'control' }
      else finish(batch, 'canceled', this.nowIso(), reason)
      return { value: structuredClone(batch) }
    })
  }

  async retry(batchId) {
    return this.mutate(async (state) => {
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch || !['failed', 'observed'].includes(batch.status) || state.outbound.some((entry) => entry.batchId === batchId)) throw new Error('Only failed/observed batches with no attempted sends can be retried. Inspect uncertain work manually.')
      const rule = state.rules.find((item) => item.id === batch.ruleId)
      if (!rule || rule.status !== 'active' || rule.humanHold) throw new Error('Activate/release the rule first.')
      const draft = batch.review?.revisions.at(-1)
      if (draft && !['queued', 'published'].includes(draft.delivery)) throw new Error('Draft publication is uncertain; inspect the stored key before any recovery.')
      Object.assign(batch, { status: draft ? (draft.delivery === 'queued' || batch.reviewAction ? 'review_waiting' : 'review_ready') : 'pending', dueAt: this.nowIso(), completedAt: null, decision: null, invalidated: null, lastError: null })
      return { value: structuredClone(batch) }
    })
  }

  async preview(name, messageIds, sourceJid) {
    return this.mutate(async (state) => {
      const rule = state.rules.find((item) => item.name === name && item.status !== 'removed')
      if (!rule || !messageIds.length || messageIds.length > rule.maxBatchMessages || !messageIds.every(text)) throw new Error('A rule and a bounded list of message IDs are required.')
      const batch = { id: id(), ruleId: rule.id, ruleName: rule.name, sourceJid, messageIds: [...new Set(messageIds)], status: 'pending', observe: true, createdAt: this.nowIso(), dueAt: this.nowIso(), completedAt: null, lastError: null, output: null }
      state.batches.push(batch)
      return { value: structuredClone(batch) }
    })
  }

  // Persist an intent (including the WhatsApp ID) before crossing the transport
  // boundary. Never retry an ambiguous transport call, even after a restart.
  async send({ batchId, runId, reviewKey = null, jid, text: body }, transport, preflight = () => true) {
    return this.withLock(async () => {
      const state = await this.load()
      const batch = reviewKey ? state.batches.find((b) => b.id === batchId) : activeBatch(state, batchId, runId).batch
      const rule = state.rules.find((r) => r.id === batch?.ruleId)
      if (reviewKey) {
        const draft = batch?.review?.revisions.at(-1)
        const evidence = draft && latestReplies(draft.events).find((e) => e.id === draft.decision?.replyId)
        if (!rule?.review || batch.status !== 'review_waiting' || batch.invalidated || rule.status !== 'active' || rule.humanHold || draft?.key !== reviewKey || draft.delivery !== 'published' || draft.decision?.action !== 'approve' || draft.decision.cursor !== draft.cursor || !evidence || !authorizedReply(rule.review, evidence) || draft.targetJid !== jid || draft.text !== body || Date.parse(batch.review.expiresAt) <= this.now()) throw new Error('No current approval for this exact draft and destination.')
      } else if (rule.review) throw new Error('This rule requires a reviewed draft; direct sends are disabled.')
      if (!await preflight(rule, batch)) throw new Error('Source coverage or WhatsApp connection is no longer fresh; no send was started.')
      if ((!reviewKey && (batch.status !== 'running' || batch.report)) || rule.mode !== 'live' || batch.observe) throw new Error('This run has no permission to send.')
      if (state.outbound.some((entry) => entry.batchId === batchId && entry.status !== 'accepted')) throw new Error('Previous send is uncertain; no further sends are allowed for this batch.')
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([jid, body])).digest('hex')
      const previous = state.outbound.find((entry) => entry.batchId === batchId && entry.fingerprint === fingerprint)
      if (previous) {
        if (previous.status === 'accepted') return { sent: true, id: previous.messageId, replayed: true }
        throw new Error('Previous send is uncertain; inspect delivery before any replacement.')
      }
      const hourly = state.outbound.filter((entry) => entry.ruleId === rule.id && Date.parse(entry.createdAt) > this.now() - 3600000)
      if (hourly.length >= rule.maxRepliesPerHour) {
        rule.humanHold = true
        invalidate(state, rule.id, this.nowIso(), 'Reply limit reached; release manually after review.', { pendingStatus: 'human' })
        await this.save(state)
        throw new Error('Hourly reply limit reached. Automation is on human hold.')
      }
      const entry = { batchId, ruleId: rule.id, runId, jid, fingerprint, messageId: `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`, status: 'sending', createdAt: this.nowIso() }
      state.outbound.push(entry)
      await this.save(state)
      let timer
      try {
        const result = await Promise.race([transport(entry.messageId), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Transport confirmation timed out; inspect the reserved message ID.')), 30000); timer.unref() })])
        if (result?.key?.id !== entry.messageId) throw new Error('Transport did not confirm the reserved message ID.')
        entry.status = 'accepted'
        entry.acceptedAt = this.nowIso()
        if (reviewKey) { finish(batch, 'completed', this.nowIso()); batch.sendCount = 1; batch.summary = 'Sent the exact reviewed draft.' }
        await this.save(state)
        return { sent: true, id: entry.messageId, replayed: false }
      } catch (error) {
        entry.status = 'uncertain'
        if (reviewKey) { finish(batch, 'uncertain', this.nowIso(), 'Reviewed WhatsApp delivery uncertain; inspect the reserved message ID.'); rule.humanHold = true; invalidate(state, rule.id, this.nowIso(), 'Uncertain reviewed delivery.', { pendingStatus: 'human' }) }
        await this.save(state)
        throw error
      } finally { clearTimeout(timer) }
    })
  }

  async complete(batchId, result) { return this.transition(batchId, (batch) => Object.assign(batch, { status: 'completed', completedAt: this.nowIso(), output: result?.output || null, lastError: null })) }
  async uncertain(batchId, error, output = null) { return this.transition(batchId, (batch) => Object.assign(batch, { status: 'uncertain', completedAt: this.nowIso(), output, lastError: String(error) })) }
  async transition(batchId, update) {
    return this.mutate(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId)
      if (!batch) throw new Error(`Unknown prompt automation batch: ${batchId}`)
      if (!ACTIVE.has(batch.status)) return { value: structuredClone(batch), save: false }
      update(batch)
      return { value: structuredClone(batch) }
    })
  }

  async recoverInterrupted() {
    return this.mutate(async (state) => {
      const recovered = []
      for (const batch of state.batches.filter((entry) => ACTIVE.has(entry.status))) {
        if (batch.status === 'clarifying') {
          if (batch.invalidated && batch.invalidationKind !== 'human_replies') batch.status = 'human_frozen'
          else if (!batch.invalidated && batch.human.decision?.cursor === batch.human.cursor && batch.human.decision.sourceEpoch === (batch.sourceEpoch || 0)) commitHumanDecision(batch, this.nowIso())
          else { Object.assign(batch, { status: 'human_ready', invalidated: null, invalidationKind: null }); batch.human.decision = null }
          recovered.push(structuredClone(batch)); continue
        }
        if (batch.status === 'reviewing') {
          // Interpretation has no external side effects. A committed decision
          // survives restart; otherwise present the unprocessed replies again.
          if (batch.invalidated && batch.invalidationKind !== 'review_replies') finish(batch, 'superseded', this.nowIso(), batch.invalidated)
          else if (batch.invalidationKind === 'review_replies') Object.assign(batch, { status: 'review_ready', invalidated: null, invalidationKind: null, reviewAction: null })
          else if (batch.reviewAction?.action === 'cancel') finish(batch, 'canceled', this.nowIso(), batch.reviewAction.reason)
          else batch.status = batch.reviewAction ? 'review_waiting' : 'review_ready'
          recovered.push(structuredClone(batch)); continue
        }
        finish(batch, batch.status === 'judging' ? 'failed' : 'uncertain', this.nowIso(), 'Bridge stopped during this run. Inspect work and delivery; no automatic replay.')
        if (batch.status === 'uncertain') {
          const rule = state.rules.find((item) => item.id === batch.ruleId)
          if (rule) { rule.humanHold = true; invalidate(state, rule.id, this.nowIso(), 'Interrupted work requires review.', { pendingStatus: 'human' }) }
        }
        recovered.push(structuredClone(batch))
      }
      return { value: recovered }
    })
  }

}

export function formatPromptAutomation(rule, batches = []) {
  const counts = batches.reduce((all, batch) => ({ ...all, [batch.status]: (all[batch.status] || 0) + 1 }), {})
  const direction = rule.direction === 'from-me' ? 'mensajes propios' : rule.direction === 'incoming' ? 'entrantes' : 'ambas direcciones'
  return `${rule.name} — ${rule.status}${rule.humanHold ? ' (control humano)' : ''}\n  Modo: ${rule.mode || 'live'}; juez: ${rule.judgeProfile || 'sin juez'}; pausa por mensaje propio: ${rule.humanTakeover ? 'sí' : 'no'}\n  Disparador: ${rule.trigger || 'messages'}; revisión: ${rule.review ? `${rule.review.actor} (${rule.review.profile})` : 'sin revisión'}\n  Consulta humana: ${rule.humanConsultation ? `${rule.humanConsultation.actor} (${rule.humanConsultation.profile}); sin cancelación por demora` : 'sin configurar'}\n  Perfil: ${rule.profile}; debounce: ${rule.debounceSeconds}s; máximo: ${rule.maxWaitSeconds || 'legacy'}s; límite: ${rule.maxRepliesPerHour || 20} respuestas/hora\n  Fuente: ${rule.source} (${rule.sourceJid}; ${direction})\n  Destino autorizado: ${rule.destination} (${rule.destinationJid})\n  Ejecuciones: ${Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(', ') || 'ninguna'}\n  Envíos aceptados por WhatsApp: ${batches.reduce((n, batch) => n + (batch.sendCount || 0), 0)} (no equivale a lectura)`
}
