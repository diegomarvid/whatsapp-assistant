import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
const exec = promisify(execFile)

test('wa qr rejects old disk QR when bridge is closed, unavailable, or lease expired', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-qr-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'data'))
  await fs.writeFile(path.join(root, 'data/bridge-token'), 'test-token')
  await fs.writeFile(path.join(root, 'data/link-qr.txt'), 'obsolete-secret')
  let expired = false
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token')
    res.writeHead(expired ? 200 : 409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(expired ? { code: 'expired-secret', id: 'abc', expiresAt: 1 } : { error: 'no_live_qr' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = { ...process.env, WA_STATE_DIR: root, WA_BRIDGE_PORT: String(server.address().port) }
  const invoke = async (expected) => {
    await assert.rejects(exec(process.execPath, ['bin/wa.js', 'qr'], { env }), error => {
      assert.match(error.stderr, expected)
      assert.doesNotMatch(error.stdout, /obsolete-secret|expired-secret|Scan/)
      return true
    })
  }
  await invoke(/No live QR/)
  expired = true
  await invoke(/QR expired/)
  await new Promise(resolve => server.close(resolve))
  await invoke(/No live QR/)
})
