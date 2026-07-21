import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function outboundFingerprint(operation) {
  return crypto.createHash('sha256').update(JSON.stringify(operation)).digest('base64url')
}

export class PendingOutboundRequests {
  constructor(filename, { ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.filename = filename
    this.ttlMs = ttlMs
    this.now = now
  }

  async claim(operation) {
    const fingerprint = outboundFingerprint(operation)
    const requests = await this.load()
    const existing = requests[fingerprint]
    if (existing) return { fingerprint, requestId: existing.requestId, reused: true }
    const requestId = crypto.randomUUID().replace(/-/g, '')
    requests[fingerprint] = { requestId, createdAt: this.now() }
    await this.save(requests)
    return { fingerprint, requestId, reused: false }
  }

  async complete(fingerprint) {
    const requests = await this.load()
    if (!requests[fingerprint]) return
    delete requests[fingerprint]
    await this.save(requests)
  }

  async load() {
    let parsed = {}
    try {
      parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const cutoff = this.now() - this.ttlMs
    return Object.fromEntries(Object.entries(parsed || {}).filter(([, request]) => request?.requestId && Number(request.createdAt) >= cutoff))
  }

  async save(requests) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(requests, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, this.filename)
  }
}
