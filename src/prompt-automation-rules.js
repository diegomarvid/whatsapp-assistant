import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 2
const RULE_STATUSES = new Set(['active', 'paused', 'removed'])
const ACTIVE = new Set(['judging', 'running'])
const BATCH_STATUSES = new Set(['pending', 'judging', 'running', 'waiting', 'completed', 'uncertain', 'failed', 'human', 'ignored', 'observed', 'canceled', 'superseded'])
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
    && text(batch.sourceJid) && Array.isArray(batch.messageIds) && batch.messageIds.length > 0 && batch.messageIds.every(text)
    && BATCH_STATUSES.has(batch.status) && typeof batch.createdAt === 'string' && typeof batch.dueAt === 'string'
    && (batch.completedAt === null || typeof batch.completedAt === 'string')
    && (batch.lastError === null || typeof batch.lastError === 'string')
    && (batch.output === null || typeof batch.output === 'string')
}

function defaults(rule) {
  return {
    mode: 'live', judgeProfile: null, maxWaitSeconds: Math.min(3600, Math.max(60, rule.debounceSeconds * 3)),
    maxBatchMessages: 100, humanTakeover: false, humanHold: false, maxRepliesPerHour: 20,
    ...rule,
    ...(rule.sourceJid?.endsWith('@g.us') ? { sourceOriginalJid: rule.sourceJid } : {}),
    ...(rule.destinationJid?.endsWith('@g.us') ? { destinationOriginalJid: rule.destinationJid } : {}),
  }
}

function normalize(value) {
  if (!value || ![1, VERSION].includes(value.version) || !Array.isArray(value.rules) || !Array.isArray(value.batches)
    || value.rules.some((rule) => !validRule(rule)) || value.batches.some((batch) => !validBatch(batch))) {
    throw new Error('Prompt automation state is malformed. It was left unchanged; inspect the private state before enabling or editing a rule.')
  }
  const rules = value.rules.map((rule) => defaults({ reconcileAfter: value.version === 1 ? Math.floor(Date.now() / 1000) : rule.activeAfter, ...rule }))
  for (const rule of rules) validateOptions(rule)
  if (value.outbound !== undefined && (!Array.isArray(value.outbound) || value.outbound.some((entry) => !text(entry.messageId) || !text(entry.batchId) || !text(entry.jid) || !text(entry.fingerprint) || !['sending', 'accepted', 'uncertain'].includes(entry.status) || !Number.isFinite(Date.parse(entry.createdAt))))) throw new Error('Malformed automation outbound audit.')
  return { version: VERSION, rules, batches: value.batches, outbound: value.outbound || [] }
}

function validateOptions(rule) {
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
    if (ACTIVE.has(batch.status)) batch.invalidated = reason
    if (['pending', 'waiting'].includes(batch.status)) finish(batch, pendingStatus, now, reason)
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
    this.lockFilename = `${filename}.lock`
    this.now = now
    this.lockRetryMs = lockRetryMs
    this.lockTimeoutMs = lockTimeoutMs
    this.staleLockMs = staleLockMs
  }

  nowIso() { return new Date(this.now()).toISOString() }
  nowSeconds() { return Math.floor(this.now() / 1000) }

  async load() {
    try { return normalize(JSON.parse(await fs.readFile(this.filename, 'utf8'))) } catch (error) {
      if (error.code === 'ENOENT') return { version: VERSION, rules: [], batches: [], outbound: [] }
      if (error instanceof SyntaxError) throw new Error('Prompt automation state could not be parsed. It was left unchanged; inspect the private state before enabling or editing a rule.')
      throw error
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    let handle = null
    try {
      handle = await fs.open(temporary, 'w', 0o600)
      const cutoff = this.now() - DEDUP_RETENTION_MS
      const batches = state.batches.filter((batch) => !['completed', 'ignored', 'observed', 'canceled', 'superseded'].includes(batch.status) || Date.parse(batch.completedAt || batch.createdAt) >= cutoff)
      await handle.writeFile(`${JSON.stringify({ version: VERSION, rules: state.rules, batches, outbound: state.outbound.filter((entry) => entry.status !== 'accepted' || Date.parse(entry.createdAt) >= cutoff) }, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      handle = null
      await fs.rename(temporary, this.filename)
    } catch (error) {
      await handle?.close().catch(() => {})
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
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
    mode = 'live', judgeProfile = null, maxWaitSeconds = Math.min(3600, Math.max(60, debounceSeconds * 3)),
    maxBatchMessages = 100, humanTakeover = false, maxRepliesPerHour = 20, status = 'active',
  }) {
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
        profile: profile.trim(), direction, debounceSeconds, mode, judgeProfile, maxWaitSeconds, maxBatchMessages, humanTakeover, humanHold: false, maxRepliesPerHour, status, reconcileAfter: this.nowSeconds(), activeAfter: this.nowSeconds(), createdAt: this.nowIso(), updatedAt: this.nowIso(),
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
        if (message.fromMe && rule.humanTakeover) {
          rule.humanHold = true
          invalidate(state, rule.id, this.nowIso(), 'Account owner replied.', { pendingStatus: 'human' })
          changed = true
        }
        if (!directionMatches(rule, message)) continue
        for (const waiting of state.batches.filter((batch) => batch.ruleId === rule.id && batch.status === 'waiting')) finish(waiting, 'superseded', this.nowIso(), 'New incoming messages replace the scheduled follow-up.')
        // A message arriving during generation invalidates that response. The
        // job can finish recording its work; the next job sees this report.
        for (const running of state.batches.filter((batch) => batch.ruleId === rule.id && ACTIVE.has(batch.status))) running.invalidated = 'New messages arrived during this run.'
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
    const rules = await Promise.all(state.rules.filter((rule) => rule.status === 'active').map(async (rule) => ({ ...rule, currentJid: await resolveSourceJid(rule.sourceOriginalJid) })))
    const seen = new Map(rules.map((rule) => [rule.id, new Set(state.batches.filter((batch) => batch.ruleId === rule.id).flatMap((batch) => batch.messageIds))]))
    const own = new Set(state.outbound.map((entry) => `${entry.jid}:${entry.messageId}`))
    const candidates = messages.filter((message) => message.source === 'live' && USER_CONTENT_TYPES.has(message.type) && !own.has(`${message.jid}:${message.id}`) && rules.some((rule) => [rule.sourceJid, rule.sourceOriginalJid, rule.currentJid].includes(message.jid) && message.timestamp >= Math.max(rule.activeAfter, rule.reconcileAfter || 0) && !seen.get(rule.id).has(message.id) && (directionMatches(rule, message) || (message.fromMe && rule.humanTakeover && !rule.humanHold))))
    for (const message of candidates.sort((a, b) => a.timestamp - b.timestamp)) await this.enqueue(message, { resolveSourceJid })
    return candidates.length
  }

  async claimDue({ workspaces = {}, maxConcurrent = 3 } = {}) {
    return this.mutate(async (state) => {
      const running = state.batches.filter((item) => ACTIVE.has(item.status))
      const workspaceHolds = state.batches.filter((item) => item.status === 'uncertain' && item.workspaceLock && !item.reviewedAt)
      if (running.length >= maxConcurrent) return { value: null, save: false }
      const candidates = state.batches.filter((entry) => ['pending', 'waiting'].includes(entry.status) && Date.parse(entry.dueAt) <= this.now()).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      for (const batch of candidates) {
        const rule = state.rules.find((item) => item.id === batch.ruleId)
        if (!rule || rule.status === 'removed' || (!batch.observe && (rule.status !== 'active' || rule.humanHold))) continue
        const keys = new Set([rule.sourceJid, rule.sourceOriginalJid, rule.destinationJid, rule.destinationOriginalJid, batch.sourceJid])
        const proposedWorkspace = workspaces[rule.profile] || null
        const overlaps = (other) => proposedWorkspace && other && (proposedWorkspace === other || proposedWorkspace.startsWith(`${other}${path.sep}`) || other.startsWith(`${proposedWorkspace}${path.sep}`))
        if (workspaceHolds.some((item) => overlaps(item.workspaceLock))) continue
        const busy = running.some((other) => {
          const otherRule = state.rules.find((item) => item.id === other.ruleId)
          return other.ruleId === rule.id || [other.sourceJid, otherRule?.sourceJid, otherRule?.sourceOriginalJid, otherRule?.destinationJid, otherRule?.destinationOriginalJid].some((key) => keys.has(key))
            || overlaps(other.workspaceLock || workspaces[otherRule?.profile])
        })
        if (busy) continue
        Object.assign(batch, { status: rule.judgeProfile && !batch.decision ? 'judging' : 'running', runId: id(), workspaceLock: proposedWorkspace, startedAt: this.nowIso(), attempt: (batch.attempt || 0) + 1, invalidated: null, report: null })
        return { value: structuredClone(batch) }
      }
      return { value: null, save: false }
    })
  }

  async defer(batchId, seconds = 15) {
    return this.transition(batchId, (batch) => Object.assign(batch, { status: 'pending', dueAt: new Date(this.now() + seconds * 1000).toISOString() }))
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
      const sends = state.outbound.filter((entry) => entry.batchId === batch.id)
      batch.sendCount = sends.filter((entry) => entry.status === 'accepted').length
      batch.summary = batch.report?.summary || batch.summary || null
      if (!result.ok) {
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

  async retry(batchId) {
    return this.mutate(async (state) => {
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch || !['failed', 'observed'].includes(batch.status) || state.outbound.some((entry) => entry.batchId === batchId)) throw new Error('Only failed/observed batches with no attempted sends can be retried. Inspect uncertain work manually.')
      const rule = state.rules.find((item) => item.id === batch.ruleId)
      if (!rule || rule.status !== 'active' || rule.humanHold) throw new Error('Activate/release the rule first.')
      Object.assign(batch, { status: 'pending', dueAt: this.nowIso(), completedAt: null, decision: null, invalidated: null, lastError: null })
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
  async send({ batchId, runId, jid, text: body }, transport, preflight = () => true) {
    return this.withLock(async () => {
      const state = await this.load()
      const { batch, rule } = activeBatch(state, batchId, runId)
      if (!preflight(rule, batch)) throw new Error('Source coverage or WhatsApp connection is no longer fresh; no send was started.')
      if (batch.status !== 'running' || batch.report || rule.mode !== 'live' || batch.observe) throw new Error('This run has no permission to send.')
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
        await this.save(state)
        return { sent: true, id: entry.messageId, replayed: false }
      } catch (error) {
        entry.status = 'uncertain'
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
  return `${rule.name} — ${rule.status}${rule.humanHold ? ' (control humano)' : ''}\n  Modo: ${rule.mode || 'live'}; juez: ${rule.judgeProfile || 'sin juez'}; pausa por mensaje propio: ${rule.humanTakeover ? 'sí' : 'no'}\n  Perfil: ${rule.profile}; debounce: ${rule.debounceSeconds}s; máximo: ${rule.maxWaitSeconds || 'legacy'}s; límite: ${rule.maxRepliesPerHour || 20} respuestas/hora\n  Fuente: ${rule.source} (${rule.sourceJid}; ${direction})\n  Destino autorizado: ${rule.destination} (${rule.destinationJid})\n  Ejecuciones: ${Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(', ') || 'ninguna'}\n  Envíos aceptados por WhatsApp: ${batches.reduce((n, batch) => n + (batch.sendCount || 0), 0)} (no equivale a lectura)`
}
