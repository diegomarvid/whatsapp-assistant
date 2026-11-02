import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000
export const DEFAULT_MAX_DELIVERY_DELAY_MS = 60 * 60 * 1000
// Bounded retry policy for failures where nothing left this device (no
// recipient device, unresolvable recipient). Ambiguous results are never
// retried; a rejected send is final.
export const MAX_DELIVERY_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000]
// WhatsApp message status values reported by receipts (proto.WebMessageInfo.Status).
export const RECEIPT_STATUS = { DELIVERY_ACK: 3, READ: 4, PLAYED: 5 }
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

function jidUser(jid) {
  return typeof jid === 'string' ? jid.replace(/@.*$/, '').replace(/:\d+$/, '') : null
}

function isPhoneJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
}

// Before 0.12.2 a LID or group target got its numeric user part stored as a
// "phone" and re-encoded as <digits>@s.whatsapp.net: a phone number that does
// not exist. A phone JID is only kept when it can genuinely be one.
export function trustedPhoneIdentity({ jid, phone = null, originalJid = null }) {
  if (!isPhoneJid(originalJid) || (!isPhoneJid(jid) && jidUser(originalJid) === jidUser(jid))) return { phone: null, originalJid: null }
  return { phone: phone || jidUser(originalJid), originalJid }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.requestId !== 'string' || typeof entry.jid !== 'string' || typeof entry.text !== 'string' || !entry.text.trim() || !ACTIVE_STATUSES.has(entry.status || 'scheduled') && !['sent', 'canceled', 'expired'].includes(entry.status)) {
    throw new Error('Scheduled messages queue is malformed. It was left unchanged; inspect the private queue before scheduling another message.')
  }
  const dueAt = validDate(entry.dueAt).toISOString()
  const status = entry.status || 'scheduled'
  // Final entries keep their audit trail as recorded; pending ones are repaired
  // so they can never be delivered to a fabricated phone number.
  const identity = ACTIVE_STATUSES.has(status)
    ? trustedPhoneIdentity(entry)
    : { phone: entry.phone || null, originalJid: entry.originalJid || null }
  return {
    ...entry,
    status,
    dueAt,
    requestedAt: entry.requestedAt || entry.dueAt,
    alias: entry.alias || null,
    ...identity,
    attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
    lastAttemptAt: entry.lastAttemptAt || null,
    nextAttemptAt: entry.nextAttemptAt || null,
    sentAt: entry.sentAt || null,
    messageId: entry.messageId || null,
    lastError: entry.lastError || null,
    failureCode: entry.failureCode || null,
    failedAt: entry.failedAt || null,
    deliveredJid: entry.deliveredJid || null,
    recipientDevices: Number.isInteger(entry.recipientDevices) ? entry.recipientDevices : null,
    serverAckAt: entry.serverAckAt || null,
    deliveredAt: entry.deliveredAt || null,
    readAt: entry.readAt || null,
    playedAt: entry.playedAt || null,
  }
}

function deliveryFields(delivery) {
  if (!delivery) return {}
  return {
    deliveredJid: delivery.jid || null,
    recipientDevices: Number.isInteger(delivery.recipientDevices) ? delivery.recipientDevices : null,
    serverAckAt: delivery.serverAckAt ? new Date(delivery.serverAckAt * 1000).toISOString() : null,
  }
}

// What WhatsApp has confirmed for a sent entry, from strongest to weakest.
export function deliveryState(message) {
  if (message.status !== 'sent') return null
  if (message.playedAt) return 'played'
  if (message.readAt) return 'read'
  if (message.deliveredAt) return 'delivered'
  if (message.serverAckAt) return 'server_ack'
  return 'unconfirmed'
}

function statusForList(message, now) {
  if (message.status === 'scheduled' && message.nextAttemptAt) return 'retrying'
  if (message.status === 'scheduled' && new Date(message.dueAt).valueOf() <= now) return 'overdue'
  // A sent entry shows what WhatsApp confirmed: delivered/read once a receipt
  // arrives, sent once the server acked it. Entries sent before 0.12.2 had no
  // server-ack check and stay "sent (unconfirmed)".
  const delivery = deliveryState(message)
  if (delivery === 'played' || delivery === 'read' || delivery === 'delivered') return delivery
  if (delivery === 'unconfirmed') return 'sent (unconfirmed)'
  return message.status
}

export function scheduledStatusLabel(message, now = Date.now()) {
  return statusForList(message, now)
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

function localTime(iso, timeZone) {
  if (!iso) return null
  return new Intl.DateTimeFormat('es-UY', { timeZone, dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(iso))
}

// Full audit of one entry for `wa schedule show`.
export function describeScheduledMessage(message, { now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const lines = [
    `ID: ${message.id}`,
    `Estado: ${statusForList(message, now)}`,
    `Programado: ${formatScheduledMessage(message, { now, timeZone }).split(' — ').slice(2, 3)[0]}`,
    `Destinatario: ${message.target}${message.alias ? ` (alias ${message.alias}, se vuelve a resolver al enviar)` : ''}`,
  ]
  if (message.deliveredJid) lines.push(`Destino usado: ${message.deliveredJid}${message.recipientDevices ? ` (${message.recipientDevices} dispositivo${message.recipientDevices === 1 ? '' : 's'})` : ''}`)
  if (message.status === 'sent') {
    lines.push(`Servidor WhatsApp: ${message.serverAckAt ? `ack ${localTime(message.serverAckAt, timeZone)}` : 'sin ack registrado (enviado antes de 0.12.2: no verificado)'}`)
    lines.push(`Entregado: ${message.deliveredAt ? localTime(message.deliveredAt, timeZone) : 'sin receipt de entrega todavía'}`)
    if (message.readAt) lines.push(`Leído: ${localTime(message.readAt, timeZone)}`)
    if (message.playedAt) lines.push(`Reproducido: ${localTime(message.playedAt, timeZone)}`)
  }
  if (message.attempts) lines.push(`Intentos: ${message.attempts}${message.nextAttemptAt ? `; próximo ${localTime(message.nextAttemptAt, timeZone)}` : ''}`)
  if (message.messageId) lines.push(`WhatsApp ID: ${message.messageId}`)
  lines.push(`Mensaje: ${message.text}`)
  if (message.lastError) lines.push(`Detalle: ${message.lastError}`)
  return lines.join('\n')
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

  async add({ target, jid, alias = null, phone = null, originalJid = null, text, at }) {
    if (!target || !jid || !text?.trim()) throw new Error('A recipient and non-empty message are required.')
    const dueAt = validDate(at)
    const delay = dueAt.valueOf() - this.now()
    if (delay <= 0) throw new Error('The scheduled date must be in the future.')
    if (delay > MAX_SCHEDULE_HORIZON_MS) throw new Error('A message can be scheduled at most one year ahead.')
    return this.mutate(async (queue) => {
      const message = normalizeEntry({
        id: newId(), requestId: newId(), target, jid, alias, ...trustedPhoneIdentity({ jid, phone, originalJid }),
        text: text.trim(), dueAt: dueAt.toISOString(), requestedAt: at,
        createdAt: new Date(this.now()).toISOString(), status: 'scheduled', attempts: 0,
      })
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
        .filter((entry) => entry.status === 'scheduled' && new Date(entry.dueAt).valueOf() <= this.now()
          && (!entry.nextAttemptAt || new Date(entry.nextAttemptAt).valueOf() <= this.now()))
        .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0]
      if (!message) return { value: null, save: false }
      message.status = 'sending'
      message.attempts += 1
      message.lastAttemptAt = new Date(this.now()).toISOString()
      message.nextAttemptAt = null
      return { value: structuredClone(message) }
    })
  }

  async complete(id, result) {
    return this.transition(id, ['sending'], (message) => Object.assign(message, {
      status: 'sent', sentAt: new Date(this.now()).toISOString(), messageId: result?.id || null, lastError: null, failureCode: null,
      ...deliveryFields(result?.delivery),
    }))
  }

  async failed(id, error) {
    return this.transition(id, ['sending'], (message) => Object.assign(message, {
      status: 'failed', lastError: error.message || String(error), failureCode: error.code || null, failedAt: new Date(this.now()).toISOString(), nextAttemptAt: null,
    }))
  }

  // A failure where nothing left this device. Retry inside the delivery
  // window up to the attempt limit; otherwise the entry becomes failed.
  async failAttempt(id, error, { retryable = false, maxAttempts = MAX_DELIVERY_ATTEMPTS, retryDelaysMs = RETRY_DELAYS_MS, maxDelayMs = DEFAULT_MAX_DELIVERY_DELAY_MS } = {}) {
    return this.transition(id, ['sending'], (message) => {
      const delay = retryDelaysMs[Math.min(Math.max(message.attempts - 1, 0), retryDelaysMs.length - 1)]
      const nextAttemptAt = this.now() + delay
      const withinWindow = nextAttemptAt - new Date(message.dueAt).valueOf() <= maxDelayMs
      Object.assign(message, { lastError: error.message || String(error), failureCode: error.code || null })
      if (retryable && message.attempts < maxAttempts && withinWindow) {
        Object.assign(message, { status: 'scheduled', nextAttemptAt: new Date(nextAttemptAt).toISOString() })
      } else {
        Object.assign(message, { status: 'failed', failedAt: new Date(this.now()).toISOString(), nextAttemptAt: null })
      }
    })
  }

  // Records a WhatsApp delivery/read receipt for a sent entry. Receipts only
  // move forward and never change the entry's status.
  async recordReceipt(messageId, status, at = null) {
    const level = Number(status)
    if (!messageId || !Number.isFinite(level) || level < RECEIPT_STATUS.DELIVERY_ACK) return null
    return this.mutate(async (queue) => {
      const message = queue.messages.find((entry) => entry.messageId === messageId && entry.status === 'sent')
      if (!message) return { value: null, save: false }
      const when = new Date((Number(at) > 0 ? Number(at) * 1000 : this.now())).toISOString()
      let changed = false
      for (const [field, threshold] of [['deliveredAt', RECEIPT_STATUS.DELIVERY_ACK], ['readAt', RECEIPT_STATUS.READ], ['playedAt', RECEIPT_STATUS.PLAYED]]) {
        if (level >= threshold && !message[field]) { message[field] = when; changed = true }
      }
      return { value: changed ? structuredClone(message) : null, save: changed }
    })
  }

  async sentMessageIds() {
    return (await this.load()).messages.filter((entry) => entry.status === 'sent' && entry.messageId).map((entry) => entry.messageId)
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
          Object.assign(message, { status: 'sent', sentAt: request.sentAt ? new Date(request.sentAt * 1000).toISOString() : new Date(this.now()).toISOString(), messageId: request.result?.key?.id || null, lastError: null, ...deliveryFields(request.result?.delivery) })
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
        const windowText = `Delivery window expired after ${Math.round(maxDelayMs / 60000)} minutes.`
        // A message that was already attempted failed for a reason; say it.
        if (message.lastError) Object.assign(message, { status: 'failed', failedAt: new Date(this.now()).toISOString(), nextAttemptAt: null, lastError: `${windowText} Last attempt: ${message.lastError}` })
        else Object.assign(message, { status: 'expired', lastError: windowText })
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
