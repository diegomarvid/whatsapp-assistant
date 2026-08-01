import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000
export const DEFAULT_MAX_DELIVERY_DELAY_MS = 60 * 60 * 1000
const ACTIVE_STATUSES = new Set(['scheduled', 'sending', 'uncertain', 'failed'])

function newId() {
  return crypto.randomUUID().replace(/-/g, '')
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function validDate(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    throw new Error('Use an ISO 8601 date with timezone, for example: 2026-08-03T21:00:00-03:00')
  }
  const normalized = value.replace(/z$/i, 'Z').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')
  const dueAt = new Date(normalized)
  if (Number.isNaN(dueAt.valueOf())) throw new Error('Use an ISO 8601 date with timezone, for example: 2026-08-03T21:00:00-03:00')
  return dueAt
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.requestId !== 'string' || typeof entry.jid !== 'string' || typeof entry.text !== 'string' || !entry.text.trim() || !ACTIVE_STATUSES.has(entry.status || 'scheduled') && !['sent', 'canceled', 'expired'].includes(entry.status)) {
    throw new Error('Scheduled messages queue is malformed. It was left unchanged; inspect the private queue before scheduling another message.')
  }
  const dueAt = validDate(entry.dueAt).toISOString()
  return {
    ...entry,
    dueAt,
    requestedAt: entry.requestedAt || entry.dueAt,
    phone: entry.phone || null,
    originalJid: entry.originalJid || null,
    attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
    lastAttemptAt: entry.lastAttemptAt || null,
    sentAt: entry.sentAt || null,
    messageId: entry.messageId || null,
    lastError: entry.lastError || null,
  }
}

function statusForList(message, now) {
  if (message.status === 'scheduled' && new Date(message.dueAt).valueOf() <= now) return 'overdue'
  return message.status
}

function timezoneLabel(date, timeZone) {
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT'
  return `${timeZone}, UTC${offset === 'GMT' ? '+00:00' : offset.replace(/^GMT/, '')}`
}

export function formatScheduledMessage(message, { now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const dueAt = new Date(message.dueAt)
  const localTime = new Intl.DateTimeFormat('es-UY', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(dueAt)
  return `${message.id} — ${statusForList(message, now)} — ${localTime} (${timezoneLabel(dueAt, timeZone)}) — ${message.target}: ${message.text}`
}

// Scheduled text necessarily remains in private local state until it is sent.
// Every writer takes an exclusive lock. A claimed message is never retried after
// an ambiguous send result: it becomes uncertain and requires explicit review.
export class ScheduledMessages {
  constructor(filename, { now = () => Date.now(), lockRetryMs = 25, lockTimeoutMs = 5000, staleLockMs = 60 * 1000 } = {}) {
    this.filename = filename
    this.lockFilename = `${filename}.lock`
    this.now = now
    this.lockRetryMs = lockRetryMs
    this.lockTimeoutMs = lockTimeoutMs
    this.staleLockMs = staleLockMs
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
        throw new Error('Scheduled messages queue is malformed. It was left unchanged; inspect the private queue before scheduling another message.')
      }
      return { version: 2, messages: parsed.messages.map(normalizeEntry) }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 2, messages: [] }
      if (error instanceof SyntaxError) throw new Error('Scheduled messages queue could not be parsed. It was left unchanged; inspect the private queue before scheduling another message.')
      throw error
    }
  }

  async save(queue) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    let handle = null
    try {
      handle = await fs.open(temporary, 'w', 0o600)
      await handle.writeFile(`${JSON.stringify({ version: 2, messages: queue.messages }, null, 2)}\n`)
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
          const stale = this.now() - (await fs.stat(this.lockFilename)).mtimeMs > this.staleLockMs
          if (stale) await fs.rm(this.lockFilename, { force: true })
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError
        }
        if (this.now() >= deadline) throw new Error('Timed out waiting for the scheduled messages queue. Retry the command.')
        await wait(this.lockRetryMs)
      }
    }
    try {
      return await work()
    } finally {
      await handle.close().catch(() => {})
      await fs.rm(this.lockFilename, { force: true }).catch(() => {})
    }
  }

  async mutate(work) {
    return this.withLock(async () => {
      const queue = await this.load()
      const result = await work(queue)
      if (result?.save !== false) await this.save(queue)
      return result?.value
    })
  }

  async add({ target, jid, phone = null, originalJid = null, text, at }) {
    if (!target || !jid || !text?.trim()) throw new Error('A recipient and non-empty message are required.')
    const dueAt = validDate(at)
    const delay = dueAt.valueOf() - this.now()
    if (delay <= 0) throw new Error('The scheduled date must be in the future.')
    if (delay > MAX_SCHEDULE_HORIZON_MS) throw new Error('A message can be scheduled at most one year ahead.')
    return this.mutate(async (queue) => {
      const message = {
        id: newId(), requestId: newId(), target, jid, phone, originalJid,
        text: text.trim(), dueAt: dueAt.toISOString(), requestedAt: at,
        createdAt: new Date(this.now()).toISOString(), status: 'scheduled', attempts: 0,
        lastAttemptAt: null, sentAt: null, messageId: null, lastError: null,
      }
      queue.messages.push(message)
      return { value: structuredClone(message) }
    })
  }

  async list({ all = false } = {}) {
    const messages = (await this.load()).messages
      .filter((message) => all || ACTIVE_STATUSES.has(message.status))
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    return messages
  }

  async get(id) {
    return (await this.load()).messages.find((entry) => entry.id === id) || null
  }

  async cancel(id) {
    return this.mutate(async (queue) => {
      const message = queue.messages.find((entry) => entry.id === id)
      if (!message) throw new Error(`Unknown scheduled message: ${id}`)
      if (!['scheduled', 'uncertain', 'failed'].includes(message.status)) {
        throw new Error(`This message is already being handed to WhatsApp or is final (current status: ${message.status}). Its result cannot be safely canceled.`)
      }
      message.status = 'canceled'
      return { value: structuredClone(message) }
    })
  }

  async claimDue() {
    return this.mutate(async (queue) => {
      const message = queue.messages
        .filter((entry) => entry.status === 'scheduled' && new Date(entry.dueAt).valueOf() <= this.now())
        .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0]
      if (!message) return { value: null, save: false }
      message.status = 'sending'
      message.attempts += 1
      message.lastAttemptAt = new Date(this.now()).toISOString()
      message.lastError = null
      return { value: structuredClone(message) }
    })
  }

  async complete(id, result) {
    return this.transition(id, ['sending'], (message) => Object.assign(message, {
      status: 'sent', sentAt: new Date(this.now()).toISOString(), messageId: result?.id || null, lastError: null,
    }))
  }

  async failed(id, error) {
    return this.transition(id, ['sending'], (message) => Object.assign(message, {
      status: 'failed', lastError: error.message || String(error),
    }))
  }

  async uncertain(id, requestId, error = null) {
    return this.transition(id, ['sending'], (message) => Object.assign(message, {
      status: 'uncertain', lastError: error?.message || `Send result was interrupted; request ${requestId} was not retried automatically.`,
    }))
  }

  async recoverInterrupted(lookupRequest) {
    return this.mutate(async (queue) => {
      const recovered = []
      for (const message of queue.messages.filter((entry) => entry.status === 'sending')) {
        const request = await lookupRequest(message.requestId)
        if (request?.status === 'sent') {
          Object.assign(message, { status: 'sent', sentAt: request.sentAt ? new Date(request.sentAt * 1000).toISOString() : new Date(this.now()).toISOString(), messageId: request.result?.key?.id || null, lastError: null })
        } else {
          Object.assign(message, { status: 'uncertain', lastError: `Bridge stopped during delivery; request ${message.requestId} was not retried automatically.` })
        }
        recovered.push(structuredClone(message))
      }
      return { value: recovered, save: recovered.length > 0 }
    })
  }

  async expireOverdue({ maxDelayMs = DEFAULT_MAX_DELIVERY_DELAY_MS } = {}) {
    return this.mutate(async (queue) => {
      const expired = []
      for (const message of queue.messages) {
        if (message.status !== 'scheduled' || this.now() - new Date(message.dueAt).valueOf() <= maxDelayMs) continue
        Object.assign(message, { status: 'expired', lastError: `Delivery window expired after ${Math.round(maxDelayMs / 60000)} minutes.` })
        expired.push(structuredClone(message))
      }
      return { value: expired, save: expired.length > 0 }
    })
  }

  async transition(id, expected, mutate) {
    return this.mutate(async (queue) => {
      const message = queue.messages.find((entry) => entry.id === id)
      if (!message) throw new Error(`Unknown scheduled message: ${id}`)
      if (!expected.includes(message.status)) return { value: structuredClone(message), save: false }
      mutate(message)
      return { value: structuredClone(message) }
    })
  }
}
