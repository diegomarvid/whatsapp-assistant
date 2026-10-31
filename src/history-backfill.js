// Recovers history without a new QR, using two requests WhatsApp Web itself
// makes to the linked phone:
//
// 1. repair: messages this companion received but could not decrypt are
//    stored as empty placeholders. The phone still has them; a placeholder
//    resend request makes it send the content again (same message ID, so the
//    mirror merges it into the placeholder).
// 2. backfill: for each chat, ask the phone for the 50 messages before the
//    oldest one the mirror holds, until the retention window is covered, the
//    chat has no older history or the phone stops answering.
//
// One request is in flight at a time, so an ON_DEMAND history set answers the
// request that is waiting. The job keeps no state of its own: the anchor is
// always the oldest stored message, so running it again resumes where the
// mirror stands. It never sends anything to a contact.
const SKIPPED_SUFFIXES = ['@broadcast', '@newsletter']

function skipped(jid) {
  return !jid || SKIPPED_SUFFIXES.some((suffix) => jid.endsWith(suffix))
}

function oldestOf(messages) {
  let oldest = null
  for (const message of messages || []) {
    if (!message?.id || !Number.isFinite(Number(message.timestamp))) continue
    if (!oldest || Number(message.timestamp) < Number(oldest.timestamp)) oldest = message
  }
  return oldest
}

function emptyState() {
  return {
    running: false,
    phase: null,
    startedAt: null,
    finishedAt: null,
    days: null,
    cutoff: null,
    result: null,
    error: null,
    repair: { candidates: 0, requested: 0, failed: 0 },
    requests: 0,
    responses: 0,
    timeouts: 0,
    chats: { total: 0, done: 0, current: null, reachedWindow: 0, startOfChat: 0, noAnchor: 0, timedOut: 0, pageLimit: 0 },
  }
}

export class HistoryBackfill {
  constructor({
    fetchHistory,
    requestResend,
    chats,
    messagesFor,
    undecrypted,
    now = () => Math.floor(Date.now() / 1000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger = null,
    pageSize = 50,
    pauseMs = 2000,
    repairPauseMs = 250,
    responseTimeoutMs = 45_000,
    maxConsecutiveTimeouts = 3,
    maxPagesPerChat = 200,
    maxRequests = 5000,
  }) {
    Object.assign(this, { fetchHistory, requestResend, chats, messagesFor, undecrypted, now, sleep, logger, pageSize, pauseMs, repairPauseMs, responseTimeoutMs, maxConsecutiveTimeouts, maxPagesPerChat, maxRequests })
    this.state = emptyState()
    this.waiter = null
    this.stopRequested = false
    this.job = null
  }

  status() {
    return structuredClone(this.state)
  }

  start({ days, jids = null, repair = true }) {
    if (this.state.running) throw new Error('backfill_running')
    const windowDays = Number.parseInt(days, 10)
    if (!Number.isFinite(windowDays) || windowDays < 1) throw new Error('backfill_invalid_days')
    this.stopRequested = false
    this.state = { ...emptyState(), running: true, phase: 'starting', startedAt: this.now(), days: windowDays, cutoff: this.now() - (windowDays * 86400) }
    this.job = this.run({ jids, repair }).catch(() => {})
    return this.status()
  }

  stop() {
    this.stopRequested = true
    this.resolveWaiter(false)
    return this.status()
  }

  // Called by the bridge for every ON_DEMAND history set it ingests.
  notifyOnDemand() {
    if (this.waiter) this.state.responses++
    this.resolveWaiter(true)
  }

  resolveWaiter(value) {
    const waiter = this.waiter
    this.waiter = null
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
  }

  waitForResponse() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.resolveWaiter(false)
      }, this.responseTimeoutMs)
      this.waiter = { resolve, timer }
    })
  }

  async run({ jids, repair }) {
    try {
      if (repair) await this.repairPhase()
      if (!this.stopRequested) await this.backfillPhase(jids)
      this.state.result = this.stopRequested ? 'stopped' : 'complete'
    } catch (error) {
      this.state.result = 'failed'
      this.state.error = error.message
      this.logger?.warn({ err: error }, 'History backfill stopped')
    } finally {
      this.resolveWaiter(false)
      this.state.running = false
      this.state.phase = null
      this.state.chats.current = null
      this.state.finishedAt = this.now()
    }
  }

  async repairPhase() {
    this.state.phase = 'repair'
    const candidates = (this.undecrypted() || []).filter((message) => Number(message.timestamp) >= this.state.cutoff && !skipped(message.jid))
    this.state.repair.candidates = candidates.length
    for (const message of candidates) {
      if (this.stopRequested) return
      const key = { remoteJid: message.jid, fromMe: Boolean(message.fromMe), id: message.id, participant: message.participant || undefined }
      try {
        await this.requestResend(key, { key, messageTimestamp: message.timestamp, pushName: message.pushName || undefined, participant: message.participant || undefined })
        this.state.repair.requested++
      } catch (error) {
        this.state.repair.failed++
        this.logger?.warn({ err: error, messageId: message.id }, 'Placeholder resend request failed')
      }
      await this.sleep(this.repairPauseMs)
    }
  }

  async backfillPhase(jids) {
    this.state.phase = 'backfill'
    const cutoff = this.state.cutoff
    const targets = jids?.length
      ? jids.filter((jid) => !skipped(jid))
      : (this.chats() || [])
        .filter((chat) => !skipped(chat.jid) && Number(chat.latestAt || 0) >= cutoff)
        .sort((a, b) => Number(b.latestAt || 0) - Number(a.latestAt || 0))
        .map((chat) => chat.jid)
    this.state.chats.total = targets.length
    let consecutiveTimeouts = 0
    for (const jid of targets) {
      if (this.stopRequested) return
      this.state.chats.current = jid
      let pages = 0
      while (true) {
        if (this.stopRequested) return
        const oldest = oldestOf(await this.messagesFor(jid))
        if (!oldest) { this.state.chats.noAnchor++; break }
        if (Number(oldest.timestamp) <= cutoff) { this.state.chats.reachedWindow++; break }
        if (pages >= this.maxPagesPerChat) { this.state.chats.pageLimit++; break }
        if (this.state.requests >= this.maxRequests) throw new Error('backfill_request_limit')
        const response = this.waitForResponse()
        try {
          // The anchor keeps the JID the message was stored under: a chat can
          // hold messages under both its phone and its LID alias.
          await this.fetchHistory(this.pageSize, { remoteJid: oldest.jid || jid, id: oldest.id, fromMe: Boolean(oldest.fromMe) }, Number(oldest.timestamp) * 1000)
        } catch (error) {
          this.resolveWaiter(false)
          throw error
        }
        this.state.requests++
        pages++
        const answered = await response
        if (this.stopRequested) return
        if (!answered) {
          this.state.timeouts++
          consecutiveTimeouts++
          this.state.chats.timedOut++
          if (consecutiveTimeouts >= this.maxConsecutiveTimeouts) throw new Error('phone_not_responding')
          break
        }
        consecutiveTimeouts = 0
        const after = oldestOf(await this.messagesFor(jid))
        if (!after || Number(after.timestamp) >= Number(oldest.timestamp)) { this.state.chats.startOfChat++; break }
        await this.sleep(this.pauseMs)
      }
      this.state.chats.done++
    }
  }
}
