import { randomUUID } from 'node:crypto'
import { Browsers, DisconnectReason } from 'baileys'

export function linkOptions(policy) {
  return { browser: Browsers.macOS('Chrome'), syncFullHistory: policy.syncFullHistory }
}

// Runtime-only lease: a file left by a dead process can never authorize a QR.
export class LinkState {
  constructor(now = Date.now) { this.now = now; this.begin() }
  begin() { this.generation = randomUUID(); this.qr = null; return this.generation }
  clear() { this.qr = null }
  publish(generation, code) {
    if (generation !== this.generation) return
    this.qr = { code, id: randomUUID(), expiresAt: this.now() + 60000 }
  }
  pending(connection) {
    return connection === 'connecting' && this.qr?.expiresAt > this.now() ? this.qr : null
  }
}

export function shouldReconnect({ registered, statusCode, pairingRestarts }) {
  if (statusCode === DisconnectReason.loggedOut) return false
  // Pair-success needs one restart (515). Failed registration is manual only.
  return registered || (statusCode === DisconnectReason.restartRequired && pairingRestarts < 1)
}
