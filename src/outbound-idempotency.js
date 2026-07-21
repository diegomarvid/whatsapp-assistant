// Sending through WhatsApp is an external side effect. A lost loopback HTTP
// response must never make a CLI retry create a second WhatsApp message.
// The bridge persists the accepted request before sending, then persists the
// WhatsApp message ID on success. A pending entry after a bridge crash remains
// deliberately uncertain instead of being re-sent automatically.

export function validOutboundRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

export class IdempotentSender {
  constructor({ store }) {
    this.store = store
    this.inFlight = new Map()
  }

  async execute(requestId, send) {
    if (!requestId) return { result: await send(), replayed: false }
    const saved = this.store.get(requestId)
    if (saved?.status === 'sent') return { result: saved.result, replayed: true }
    if (this.inFlight.has(requestId)) {
      return { result: await this.inFlight.get(requestId), replayed: true }
    }
    // The process may have stopped after WhatsApp accepted the send but before
    // its message ID was persisted. Do not guess: a manual explicit retry can
    // be added later, but silent duplication is worse than an uncertain state.
    if (saved?.status === 'pending') return { pending: true, requestId }

    this.store.set(requestId, { status: 'pending', startedAt: Math.floor(Date.now() / 1000) })
    const inFlight = Promise.resolve()
      .then(send)
      .then((result) => {
        this.store.set(requestId, { status: 'sent', sentAt: Math.floor(Date.now() / 1000), result })
        return result
      })
      .catch((error) => {
        // A confirmed local failure is safe to retry. Only an interrupted or
        // unknown result remains pending.
        this.store.del(requestId)
        throw error
      })
    this.inFlight.set(requestId, inFlight)
    try {
      return { result: await inFlight, replayed: false }
    } finally {
      this.inFlight.delete(requestId)
    }
  }
}
