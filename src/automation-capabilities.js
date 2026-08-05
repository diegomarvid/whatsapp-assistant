import crypto from 'node:crypto'

function text(value) { return typeof value === 'string' && value.length > 0 }

function tokenMatches(left, right) {
  if (!text(left) || !text(right) || left.length !== right.length) return false
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

function jidSet(values) {
  return new Set((values || []).filter(text))
}

// Automation workers receive a one-use capability, not the bridge's master
// credential. The bridge validates the target JID on every request so a model
// cannot widen its own WhatsApp scope by changing a local shim or alias file.
export class AutomationCapabilities {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.records = new Map()
  }

  issue({ readJids, sendJids, ttlMs }) {
    const reads = jidSet(readJids)
    const sends = jidSet(sendJids)
    if (!reads.size || !sends.size) throw new Error('An automation capability needs at least one read and one send chat.')
    const lifetime = Number(ttlMs)
    if (!Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 10 * 60 * 1000) throw new Error('Automation capability lifetime must be between 1 second and 10 minutes.')
    this.prune()
    const token = crypto.randomBytes(32).toString('base64url')
    this.records.set(token, { readJids: reads, sendJids: sends, expiresAt: this.now() + lifetime })
    return token
  }

  revoke(token) { this.records.delete(token) }

  authorization(supplied, masterToken) {
    if (tokenMatches(supplied, masterToken)) return { kind: 'full' }
    const record = this.records.get(supplied)
    if (!record) return null
    if (record.expiresAt <= this.now()) {
      this.records.delete(supplied)
      return null
    }
    return { kind: 'automation', ...record }
  }

  canRead(authorization, jid) {
    return authorization?.kind === 'full' || (authorization?.kind === 'automation' && authorization.readJids.has(jid))
  }

  canSend(authorization, jid) {
    return authorization?.kind === 'full' || (authorization?.kind === 'automation' && authorization.sendJids.has(jid))
  }

  canResolve(authorization, jid) {
    return authorization?.kind === 'full' || (authorization?.kind === 'automation' && (authorization.readJids.has(jid) || authorization.sendJids.has(jid)))
  }

  prune() {
    for (const [token, record] of this.records) if (record.expiresAt <= this.now()) this.records.delete(token)
  }
}
