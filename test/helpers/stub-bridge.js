import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// A loopback bridge stub implementing the local API surface the CLI consumes.
// It serves fixture data and records every write so tests can assert exactly
// what an action sent, without WhatsApp or the real bridge.
export async function startStubBridge({ fixtures }) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-stub-'))
  const dataDir = path.join(stateRoot, 'data')
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const token = crypto.randomBytes(16).toString('base64url')
  await fs.writeFile(path.join(dataDir, 'bridge-token'), `${token}\n`, { mode: 0o600 })

  const writes = []
  const reads = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    reads.push(`${request.method} ${url.pathname}${url.search}`)
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/health') return json(200, fixtures.health)
    if (request.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
    if (request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        writes.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null })
        json(200, fixtures.postResponses?.[url.pathname] || { ok: true, id: 'STUB-SENT-ID' })
      })
      return
    }
    if (url.pathname === '/resolve') {
      const jid = url.searchParams.get('jid')
      return json(200, { requestedJid: jid, jid: fixtures.resolve?.[jid] || jid, remapped: Boolean(fixtures.resolve?.[jid]) })
    }
    if (url.pathname === '/coverage') return json(200, fixtures.coverage)
    if (url.pathname === '/messages') {
      const jid = url.searchParams.get('jid')
      return json(200, { jid, messages: (fixtures.messages || []).filter((message) => message.jid === jid) })
    }
    if (url.pathname === '/identities') return json(200, fixtures.identities)
    if (url.pathname === '/search') {
      return json(200, { query: url.searchParams.get('q'), messages: fixtures.searchResults || [] })
    }
    if (url.pathname === '/events') return json(200, { events: fixtures.events || [] })
    if (url.pathname === '/groups') return json(200, fixtures.groups || { groups: [] })
    return json(404, { error: 'not_found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    stateRoot,
    port,
    writes,
    reads,
    env: {
      ...process.env,
      WA_STATE_DIR: stateRoot,
      WA_BRIDGE_PORT: String(port),
      WA_NO_MAC_CONTACTS: '1',
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(stateRoot, { recursive: true, force: true })
    },
  }
}
