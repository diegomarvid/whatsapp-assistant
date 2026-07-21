import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startStubBridge } from './helpers/stub-bridge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'wa.js')

const fixtures = {
  health: { connection: 'open', lastError: null },
  coverage: { status: 'fresh', fresh: true, reasons: [] },
  resolve: {},
  identities: {
    chats: [
      { jid: '111@lid', name: 'Gisell', lastTimestamp: 1400, messageCount: 4 },
      { jid: '222@lid', name: 'Flor', lastTimestamp: 1000, messageCount: 1 },
      { jid: 'work@g.us', name: 'Equipo Maspeak', lastTimestamp: 1350, messageCount: 9 },
    ],
    contacts: { '111@lid': { name: 'Gisell' } },
  },
  messages: [
    { jid: '111@lid', id: 'OUT-9', fromMe: true, timestamp: 1400, text: 'mi mensaje más nuevo', type: 'conversation', source: 'live' },
    { jid: '111@lid', id: 'IN-2', fromMe: false, timestamp: 1300, text: 'último entrante', pushName: 'Gisell', type: 'conversation', source: 'live' },
    { jid: '111@lid', id: 'IN-1', fromMe: false, timestamp: 1100, text: 'hola presupuesto', pushName: 'Gisell', type: 'conversation', source: 'live' },
    { jid: '222@lid', id: 'FLOR-1', fromMe: false, timestamp: 1000, text: 'mensaje de flor', pushName: 'Flor', type: 'conversation', source: 'live' },
  ],
  searchResults: [
    { jid: 'work@g.us', id: 'G-1', fromMe: false, timestamp: 1350, text: 'presupuesto del grupo', pushName: 'Tomi', type: 'conversation', source: 'live' },
  ],
  events: [],
  groups: { groups: [{ jid: 'work@g.us', subject: 'Equipo Maspeak', desc: null, participantCount: 3 }] },
  postResponses: {
    '/messages/send': { sent: true, id: 'NEW-ID' },
    '/messages/react': { reacted: true },
    '/messages/edit': { edited: true },
    '/messages/revoke': { revoked: true },
    '/messages/read': { read: true },
    '/media/send': { sent: true, id: 'MEDIA-ID' },
  },
}

const bridge = await startStubBridge({ fixtures })
test.after(async () => { await bridge.close() })

function wa(...args) {
  // The stub bridge lives in this process: the CLI must run asynchronously so
  // the event loop can serve its requests.
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { encoding: 'utf8', env: bridge.env }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })
}

function lastWrite() {
  return bridge.writes[bridge.writes.length - 1]
}

test('recent lists direct chats by identity, excluding groups', async () => {
  const result = await wa('recent', '5')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Gisell \(/)
  assert.match(result.stdout, /Flor \(/)
  assert.doesNotMatch(result.stdout, /Equipo Maspeak/)
})

test('find matches a WhatsApp identity with evidence', async () => {
  const result = await wa('find', 'Gisell')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /WhatsApp: Gisell \(111@lid\)/)
})

test('latest returns the newest event and latest-incoming skips own messages', async () => {
  const latest = await wa('latest', 'Gisell', '--ids')
  assert.equal(latest.status, 0, latest.stderr)
  assert.match(latest.stdout, /mi mensaje más nuevo/)
  assert.match(latest.stdout, /\[id: OUT-9\]/)

  const incoming = await wa('latest-incoming', 'Gisell', '--ids')
  assert.equal(incoming.status, 0, incoming.stderr)
  assert.match(incoming.stdout, /último entrante/)
  assert.match(incoming.stdout, /\[id: IN-2\]/)
})

test('latest refuses to answer without fresh coverage', async () => {
  fixtures.coverage = { status: 'unknown', fresh: false, reasons: ['bridge_not_connected'] }
  try {
    const result = await wa('latest', 'Gisell')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not freshly synchronized/)
    assert.match(result.stderr, /wa coverage/)
  } finally {
    fixtures.coverage = { status: 'fresh', fresh: true, reasons: [] }
  }
})

test('an alias resolves through identities to the current chat', async () => {
  const add = await wa('alias', 'add', 'flor', '+59899111222', 'Flor')
  assert.equal(add.status, 0, add.stderr)
  const result = await wa('latest-incoming', 'flor')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /mensaje de flor/)
})

test('search-all queries the bridge with scope and group list', async () => {
  const dataDir = path.join(bridge.stateRoot, 'data')
  await fs.writeFile(path.join(dataDir, 'group-lists.json'), JSON.stringify({ lists: { maspeak: { terms: ['maspeak'], groups: [{ jid: 'work@g.us' }] } } }))
  const result = await wa('search-all', 'presupuesto', '--since', '2d', '--groups', 'maspeak')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[Equipo Maspeak \(work@g\.us\)\] .*presupuesto del grupo/)
  const searchRead = bridge.reads.find((line) => line.includes('/search?q=presupuesto'))
  assert.ok(searchRead, 'the CLI must delegate search-all to the bridge')
  assert.match(searchRead, /scope=groups/)
  assert.match(searchRead, /jids=work%40g\.us/)
  assert.match(searchRead, /since=172800/)
})

test('reply quotes the confirmed latest incoming message', async () => {
  const result = await wa('reply', 'Gisell', 'latest-incoming', 'Entendido')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(lastWrite(), {
    path: '/messages/send',
    query: {},
    body: { jid: '111@lid', text: 'Entendido', replyToMessageId: 'IN-2', mentions: [] },
  })
})

test('react targets the selected message id', async () => {
  const result = await wa('react', 'Gisell', 'latest-incoming', '👍')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(lastWrite().body, { jid: '111@lid', messageId: 'IN-2', emoji: '👍' })
})

test('edit only accepts own messages and targets the right id', async () => {
  const denied = await wa('edit', 'Gisell', 'IN-2', 'nuevo texto')
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /sent by this account/)

  const result = await wa('edit', 'Gisell', 'latest', 'nuevo texto')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(lastWrite(), { path: '/messages/edit', query: {}, body: { jid: '111@lid', messageId: 'OUT-9', text: 'nuevo texto' } })
})

test('unsend revokes the latest own message', async () => {
  const result = await wa('unsend', 'Gisell', 'latest')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(lastWrite(), { path: '/messages/revoke', query: {}, body: { jid: '111@lid', messageId: 'OUT-9' } })
})

test('mark-read emits an explicit read receipt for an incoming message', async () => {
  const result = await wa('mark-read', 'Gisell', 'latest-incoming')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(lastWrite(), { path: '/messages/read', query: {}, body: { jid: '111@lid', messageId: 'IN-2' } })

  const denied = await wa('mark-read', 'Gisell', 'OUT-9')
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /incoming message/)
})

test('send-image can quote a message with --reply-to', async () => {
  const image = path.join(bridge.stateRoot, 'foto.png')
  await fs.writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  const result = await wa('send-image', 'Gisell', image, 'una caption', '--reply-to', 'latest-incoming')
  assert.equal(result.status, 0, result.stderr)
  const write = lastWrite()
  assert.equal(write.path, '/media/send')
  assert.equal(write.body.kind, 'image')
  assert.equal(write.body.caption, 'una caption')
  assert.equal(write.body.replyToMessageId, 'IN-2')
})

test('calls and group-events consult the events endpoint', async () => {
  const calls = await wa('calls', 'Gisell')
  assert.equal(calls.status, 0, calls.stderr)
  assert.ok(bridge.reads.some((line) => line.includes('/events?kind=call')))

  const events = await wa('group-events', 'work@g.us')
  assert.equal(events.status, 0, events.stderr)
  assert.ok(bridge.reads.some((line) => line.includes('/events?kind=group')))
})
