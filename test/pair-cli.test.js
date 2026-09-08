import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
const exec = promisify(execFile)

async function bridgeFixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-pair-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'data'))
  await fs.writeFile(path.join(root, 'data/bridge-token'), 'test-token')
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null })
      handler(req, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, env: { ...process.env, WA_STATE_DIR: root, WA_BRIDGE_PORT: String(server.address().port) } }
}

test('wa pair prints the code and never reaches the bridge with a local number', async (t) => {
  const { requests, env } = await bridgeFixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: '2ZT2724Y', phone: '59894421953', expiresInSeconds: 120 }))
  })

  const ok = await exec(process.execPath, ['bin/wa.js', 'pair', '+598 94 421 953'], { env })
  assert.match(ok.stdout, /2ZT2724Y/)
  assert.match(ok.stdout, /Vincular con número de teléfono/)
  assert.match(ok.stdout, /wa status/)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/pair',
    authorization: 'Bearer test-token',
    // Human formatting is normalized before it leaves the CLI.
    body: { phone: '59894421953' },
  })

  await assert.rejects(exec(process.execPath, ['bin/wa.js', 'pair', '094421953'], { env }), (error) => {
    assert.match(error.stderr, /formato internacional/)
    return true
  })
  await assert.rejects(exec(process.execPath, ['bin/wa.js', 'pair'], { env }), (error) => {
    assert.match(error.stderr, /formato internacional/)
    return true
  })
  // A rejected number must not have been sent to WhatsApp.
  assert.equal(requests.length, 1)
})

test('wa pair surfaces a refusal from the bridge instead of inventing a code', async (t) => {
  const { env } = await bridgeFixture(t, (_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'already_registered' }))
  })
  await assert.rejects(exec(process.execPath, ['bin/wa.js', 'pair', '59894421953'], { env }), (error) => {
    assert.match(error.stderr, /No se pudo pedir el código de vinculación/)
    assert.doesNotMatch(error.stdout, /Código de vinculación/)
    return true
  })
})
