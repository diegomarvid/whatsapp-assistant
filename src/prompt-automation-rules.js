import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const RULE_STATUSES = new Set(['active', 'paused', 'removed'])
const BATCH_STATUSES = new Set(['pending', 'running', 'completed', 'uncertain'])
const DIRECTIONS = new Set(['incoming', 'from-me', 'any'])
const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
    && Number.isInteger(rule.debounceSeconds) && rule.debounceSeconds >= 5 && rule.debounceSeconds <= 3600
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

function normalize(value) {
  if (!value || typeof value !== 'object' || value.version !== VERSION || !Array.isArray(value.rules) || !Array.isArray(value.batches)
    || value.rules.some((rule) => !validRule(rule)) || value.batches.some((batch) => !validBatch(batch))) {
    throw new Error('Prompt automation state is malformed. It was left unchanged; inspect the private state before enabling or editing a rule.')
  }
  return { version: VERSION, rules: value.rules, batches: value.batches }
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
      if (error.code === 'ENOENT') return { version: VERSION, rules: [], batches: [] }
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
      const batches = state.batches.filter((batch) => batch.status === 'running' || Date.parse(batch.createdAt) >= cutoff)
      await handle.writeFile(`${JSON.stringify({ version: VERSION, rules: state.rules, batches }, null, 2)}\n`)
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
    const deadline = this.now() + this.lockTimeoutMs
    let handle = null
    while (!handle) {
      try {
        await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
        handle = await fs.open(this.lockFilename, 'wx', 0o600)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          if (this.now() - (await fs.stat(this.lockFilename)).mtimeMs > this.staleLockMs) await fs.rm(this.lockFilename, { force: true })
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError
        }
        if (this.now() >= deadline) throw new Error('Timed out waiting for prompt automations. Retry the command.')
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
  }) {
    if (!validName(name) || ![source, sourceJid, destination, destinationJid, profile].every(text) || ![sourceTarget, destinationTarget].every(validTarget)) {
      throw new Error('A rule name, source, destination, CLI targets, and AI profile are required.')
    }
    if (!DIRECTIONS.has(direction)) throw new Error('Prompt automation direction must be incoming, from-me, or any.')
    if (!Number.isInteger(debounceSeconds) || debounceSeconds < 5 || debounceSeconds > 3600) throw new Error('Debounce must be between 5 seconds and 1 hour.')
    return this.mutate(async (state) => {
      if (state.rules.some((rule) => rule.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error(`A prompt automation named ${name} already exists, including removed history.`)
      const rule = {
        id: id(), name, source: source.trim(), sourceTarget: sourceTarget.trim(), sourceJid: sourceJid.trim(), sourceOriginalJid: sourceOriginalJid?.trim() || sourceJid.trim(),
        destination: destination.trim(), destinationTarget: destinationTarget.trim(), destinationJid: destinationJid.trim(), destinationOriginalJid: destinationOriginalJid?.trim() || destinationJid.trim(),
        profile: profile.trim(), direction, debounceSeconds, status: 'active', activeAfter: this.nowSeconds(), createdAt: this.nowIso(), updatedAt: this.nowIso(),
      }
      if ([...sourceKeys(rule)].some((key) => [rule.destinationJid, rule.destinationOriginalJid].includes(key))) throw new Error('A prompt automation cannot use the same chat as source and destination.')
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
      const rule = [...state.rules].reverse().find((entry) => entry.name === name)
      if (!rule) throw new Error(`Unknown prompt automation: ${name}`)
      rule.status = status
      rule.updatedAt = this.nowIso()
      if (status === 'active') rule.activeAfter = this.nowSeconds()
      else {
        // Do not revive a message that arrived before a user paused or removed
        // a rule. No provider was run for these batches.
        for (const batch of state.batches.filter((entry) => entry.ruleId === rule.id && entry.status === 'pending')) {
          batch.status = 'uncertain'
          batch.completedAt = this.nowIso()
          batch.lastError = `The automation was ${status} before this batch ran. It was not sent to the AI provider.`
        }
      }
      return { value: structuredClone(rule) }
    })
  }

  // This is deliberately mechanical: source identity, direction, freshness,
  // and IDs only. It never looks at message text, type, links, or intent.
  async enqueue(message, { resolveSourceJid = async (jid) => jid } = {}) {
    return this.mutate(async (state) => {
      const timestamp = Number(message?.timestamp)
      if (message?.source !== 'live' || !text(message?.jid) || !text(message?.id) || !Number.isFinite(timestamp)) return { value: [], save: false }
      const matched = []
      for (const rule of state.rules.filter((entry) => entry.status === 'active')) {
        const resolved = await resolveSourceJid(rule.sourceOriginalJid)
        if (!(sourceKeys(rule).has(message.jid) || resolved === message.jid) || !directionMatches(rule, message) || timestamp < rule.activeAfter) continue
        if (state.batches.some((batch) => batch.ruleId === rule.id && batch.messageIds.includes(message.id))) continue
        let batch = state.batches.find((entry) => entry.ruleId === rule.id && entry.status === 'pending')
        if (!batch) {
          batch = { id: id(), ruleId: rule.id, ruleName: rule.name, sourceJid: message.jid, messageIds: [], status: 'pending', createdAt: this.nowIso(), dueAt: this.nowIso(), completedAt: null, lastError: null, output: null }
          state.batches.push(batch)
        }
        batch.messageIds.push(message.id)
        batch.dueAt = new Date(this.now() + rule.debounceSeconds * 1000).toISOString()
        matched.push(structuredClone(batch))
      }
      return { value: matched, save: matched.length > 0 }
    })
  }

  async claimDue() {
    return this.mutate(async (state) => {
      // One model run at a time keeps the action surface serialized and makes
      // an interrupted execution unambiguous rather than silently overlapping.
      if (state.batches.some((entry) => entry.status === 'running')) return { value: null, save: false }
      const batch = state.batches.filter((entry) => entry.status === 'pending' && Date.parse(entry.dueAt) <= this.now()).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]
      if (!batch) return { value: null, save: false }
      batch.status = 'running'
      return { value: structuredClone(batch) }
    })
  }

  async defer(batchId, seconds = 15) {
    return this.transition(batchId, (batch) => Object.assign(batch, { status: 'pending', dueAt: new Date(this.now() + seconds * 1000).toISOString() }))
  }

  async complete(batchId, result) {
    return this.transition(batchId, (batch) => Object.assign(batch, {
      status: 'completed', completedAt: this.nowIso(), output: typeof result?.output === 'string' ? result.output.slice(0, 8000) : null, lastError: null,
    }))
  }

  async uncertain(batchId, error, output = null) {
    return this.transition(batchId, (batch) => Object.assign(batch, {
      status: 'uncertain', completedAt: this.nowIso(), output: typeof output === 'string' ? output.slice(0, 8000) : null, lastError: String(error || 'The provider stopped with an unknown WhatsApp side effect. This batch was not retried automatically.').slice(0, 4000),
    }))
  }

  async transition(batchId, update) {
    return this.mutate(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId)
      if (!batch) throw new Error(`Unknown prompt automation batch: ${batchId}`)
      if (batch.status !== 'running') return { value: structuredClone(batch), save: false }
      update(batch)
      return { value: structuredClone(batch) }
    })
  }

  async recoverInterrupted() {
    return this.mutate(async (state) => {
      const recovered = []
      for (const batch of state.batches.filter((entry) => entry.status === 'running')) {
        Object.assign(batch, {
          status: 'uncertain', completedAt: this.nowIso(),
          lastError: 'The bridge stopped while the AI provider was running. The provider might have sent a WhatsApp message, so this batch was not retried automatically.',
        })
        recovered.push(structuredClone(batch))
      }
      return { value: recovered, save: recovered.length > 0 }
    })
  }
}

export function formatPromptAutomation(rule, batches = []) {
  const counts = batches.reduce((all, batch) => ({ ...all, [batch.status]: (all[batch.status] || 0) + 1 }), {})
  const direction = rule.direction === 'from-me' ? 'mensajes propios' : rule.direction === 'incoming' ? 'entrantes' : 'cualquier dirección'
  return `${rule.name} — ${rule.status}\n  Perfil: ${rule.profile}; debounce: ${rule.debounceSeconds}s\n  Fuente: ${rule.source} (${rule.sourceJid}; ${direction})\n  Destino autorizado: ${rule.destination} (${rule.destinationJid})\n  Ejecuciones: ${counts.completed || 0} terminadas, ${counts.pending || 0} esperando, ${counts.running || 0} en curso, ${counts.uncertain || 0} inciertas`
}
