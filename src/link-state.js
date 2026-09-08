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

// WhatsApp shows the pairing code for two minutes; the CLI states that limit
// instead of letting a stale code look usable.
export const PAIRING_CODE_TTL_SECONDS = 120

// Baileys wants a bare E.164 subscriber number: no '+', spaces, dashes or
// parentheses. Anything shorter than a country code plus a subscriber number,
// or with a leading zero, is a local/trunk format that cannot address a WhatsApp
// account, so it is rejected here rather than sent to the provider.
export function normalizedPairingPhone(phone) {
  const digits = String(phone ?? '').replace(/[\s()+.-]/g, '')
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null
  return digits
}

export function shouldReconnect({ registered, statusCode, pairingRestarts }) {
  if (statusCode === DisconnectReason.loggedOut) return false
  // Pair-success needs one restart (515). Failed registration is manual only.
  return registered || (statusCode === DisconnectReason.restartRequired && pairingRestarts < 1)
}
