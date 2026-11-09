import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentProfiles } from '../src/agent-providers.js'
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
    '/groups/create': {
      created: true,
      replayed: false,
      group: {
        jid: '120363000000000001@g.us',
        subject: 'Prueba',
        participants: [
          { jid: '999@lid', phoneNumber: '598999@s.whatsapp.net', lid: null, admin: 'superadmin' },
          { jid: '111@lid', phoneNumber: null, lid: null, admin: null },
        ],
        notAdded: ['222@lid'],
        memberAddMode: 'all_member_add',
      },
    },
    '/groups/member-add-mode': { updated: true },
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

test('an alias can point to a LID and is never re-encoded as a phone number', async () => {
  const add = await wa('alias', 'add', 'gi', '111@lid', 'Gi')
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /gi → Gi \(111@lid\)/)
  const stored = JSON.parse(await fs.readFile(path.join(bridge.stateRoot, 'data', 'aliases.json'), 'utf8'))
  assert.deepEqual(stored.gi, { phone: null, jid: '111@lid', name: 'Gi' })
  const list = await wa('aliases')
  assert.match(list.stdout, /gi → Gi \(111@lid\)/)
  const result = await wa('latest-incoming', 'gi')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /último entrante/)
})

test('alias add rejects something that is neither a phone nor a JID', async () => {
  const result = await wa('alias', 'add', 'nadie', 'Diego Ventura')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no es un teléfono ni un JID/)
  const stored = JSON.parse(await fs.readFile(path.join(bridge.stateRoot, 'data', 'aliases.json'), 'utf8'))
  assert.equal(stored.nadie, undefined)
})

test('alias remove deletes a saved alias and reports an unknown one', async () => {
  const add = await wa('alias', 'add', 'temporal', '+59899000111')
  assert.equal(add.status, 0, add.stderr)
  const removed = await wa('alias', 'remove', 'temporal')
  assert.equal(removed.status, 0, removed.stderr)
  assert.match(removed.stdout, /Alias removed: temporal/)
  const stored = JSON.parse(await fs.readFile(path.join(bridge.stateRoot, 'data', 'aliases.json'), 'utf8'))
  assert.equal(stored.temporal, undefined)
  const again = await wa('alias', 'rm', 'temporal')
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /No hay un alias/)
})

test('search-all queries the bridge with scope and group list', async () => {
  const dataDir = path.join(bridge.stateRoot, 'data')
  await fs.writeFile(path.join(dataDir, 'group-lists.json'), JSON.stringify({ lists: { maspeak: { terms: ['maspeak'], groups: [{ jid: 'work@g.us' }] } } }))
  const result = await wa('search-all', 'presupuesto', '--since', '2d', '--groups', 'maspeak')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[Equipo Maspeak \(work@g\.us\)\] .*presupuesto del grupo/)
  const searchRead = bridge.reads.find((line) => line.includes('/search?t=presupuesto'))
  assert.ok(searchRead, 'the CLI must delegate search-all to the bridge full-text index')
  assert.match(searchRead, /scope=groups/)
  assert.match(searchRead, /jids=work%40g\.us/)
  assert.match(searchRead, /since=172800/)
})

test('search inside a chat delegates terms, direction and window to the bridge index', async () => {
  const result = await wa('search', 'flor', 'precio final', 'hotel', '--from', 'incoming', '--date', '2026-10-01', '--json')
  assert.equal(result.status, 0, result.stderr)
  const searchRead = bridge.reads.filter((line) => line.startsWith('GET /search?')).at(-1)
  const parameters = new URL(`http://bridge${searchRead.slice(4)}`).searchParams
  assert.deepEqual(parameters.getAll('t'), ['precio final', 'hotel'])
  assert.equal(parameters.get('direction'), 'incoming')
  assert.ok(parameters.get('jid'), 'the chat is resolved before searching')
  assert.equal(Number(parameters.get('before')) - Number(parameters.get('after')), 86400)
  assert.equal(JSON.parse(result.stdout).schema, 'wa-search.v1')
})

test('history reads a past window without the fixed 200-message cap', async () => {
  const result = await wa('history', 'flor', '500', '--before', '2026-10-01')
  assert.equal(result.status, 0, result.stderr)
  const messagesRead = bridge.reads.filter((line) => line.startsWith('GET /messages?')).at(-1)
  assert.match(messagesRead, /limit=500/)
  assert.match(messagesRead, /until=\d+/)
})

test('review returns a fresh, bounded, contextual evidence packet with canonical identity', async () => {
  const now = Math.floor(Date.now() / 1000)
  const additions = [
    { jid: '111@lid', id: 'TODAY-BEFORE', fromMe: false, timestamp: now - 180, text: 'che escucha', pushName: 'Gisell', type: 'conversation', source: 'live' },
    { jid: '111@lid', id: 'TODAY-IP', fromMe: false, timestamp: now - 120, text: 'La IP es dinámica', pushName: 'Gisell', type: 'conversation', source: 'live' },
    { jid: '111@lid', id: 'TODAY-AUDIO', fromMe: true, timestamp: now - 60, text: '', pushName: 'Diego', type: 'audioMessage', audioRef: 'today.bin', source: 'live' },
  ]
  fixtures.messages.push(...additions)
  try {
    const result = await wa('review', 'Gisell', '--date', 'today', '--start', '00:00', '--end', '23:59', '--from', 'incoming', '--any', 'IP', 'dinamica', 'estática', '--context', '1', '--ids', '--json')
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schemaVersion, 'wa-review.v1')
    assert.equal(report.chat.jid, '111@lid')
    assert.equal(report.coverage.fresh, true)
    assert.deepEqual(report.query.terms, ['IP', 'dinamica', 'estática'])
    assert.equal(report.query.matching, 'whole-word-or-phrase')
    assert.equal(report.query.from, 'incoming')
    assert.match(report.window.localSince, /^\d{4}-\d{2}-\d{2} 00:00:00$/)
    assert.match(report.window.localUntil, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.deepEqual(report.matches.map((match) => match.id), ['TODAY-IP'])
    assert.equal(report.matches[0].text, 'La IP es dinámica')
    assert.match(report.matches[0].localTimestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(report.timeline.every((message) => Boolean(message.localTimestamp)), true)
    assert.deepEqual(report.timeline.map((message) => message.id), ['TODAY-BEFORE', 'TODAY-IP', 'TODAY-AUDIO'])
    assert.deepEqual(report.media.map((message) => message.id), ['TODAY-AUDIO'])
    assert.ok(bridge.reads.some((line) => line.includes('/messages?jid=111%40lid&limit=10000')))
  } finally {
    fixtures.messages.splice(fixtures.messages.length - additions.length, additions.length)
  }
})

test('review rejects unknown flags instead of turning them into search text', async () => {
  const result = await wa('review', 'Gisell', '--any', 'IP', '--bogus')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown review option/)
})

test('reply quotes the confirmed latest incoming message', async () => {
  const result = await wa('reply', 'Gisell', 'latest-incoming', 'Entendido')
  assert.equal(result.status, 0, result.stderr)
  const write = lastWrite()
  assert.equal(write.path, '/messages/send')
  assert.deepEqual(write.query, {})
  assert.equal(write.body.jid, '111@lid')
  assert.equal(write.body.text, 'Entendido')
  assert.equal(write.body.replyToMessageId, 'IN-2')
  assert.deepEqual(write.body.mentions, [])
  assert.match(write.body.requestId, /^[A-Za-z0-9_-]{16,128}$/)
})

test('groups create sends the resolved people once and reports who was not added', async () => {
  const result = await wa('groups', 'create', 'Prueba', 'Gisell', 'Flor', 'Gisell')
  assert.equal(result.status, 0, result.stderr)
  const write = lastWrite()
  assert.equal(write.path, '/groups/create')
  assert.equal(write.body.subject, 'Prueba')
  assert.deepEqual(write.body.participants, ['111@lid', '222@lid'])
  assert.equal(write.body.memberAddMode, 'all_member_add', 'groups default to everyone being able to add people')
  assert.match(write.body.requestId, /^[A-Za-z0-9_-]{16,128}$/)
  assert.match(result.stdout, /Cualquier participante puede agregar gente/)
  assert.match(result.stdout, /Grupo creado: Prueba \(120363000000000001@g\.us\)/)
  assert.match(result.stdout, /No quedó en el grupo: Flor \(222@lid\)/)
})

test('groups create --admins-add keeps adding people to admins', async () => {
  const result = await wa('groups', 'create', 'Solo admins', 'Gisell', '--admins-add')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(lastWrite().path, '/groups/create')
  assert.equal(lastWrite().body.memberAddMode, 'admin_add')
  assert.deepEqual(lastWrite().body.participants, ['111@lid'])
})

test('groups member-add changes who can add participants on an existing group', async () => {
  const result = await wa('groups', 'member-add', 'work@g.us', 'all')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(lastWrite().path, '/groups/member-add-mode')
  assert.deepEqual(lastWrite().body, { jid: 'work@g.us', mode: 'all_member_add' })
  assert.match(result.stdout, /Equipo Maspeak: cualquier participante puede agregar gente/)
  const writes = bridge.writes.length
  const bad = await wa('groups', 'member-add', 'work@g.us', 'everyone')
  assert.notEqual(bad.status, 0)
  const notGroup = await wa('groups', 'member-add', '111@lid', 'all')
  assert.notEqual(notGroup.status, 0)
  assert.equal(bridge.writes.length, writes)
})

test('groups create refuses a group as a participant and needs a name and people', async () => {
  const writes = bridge.writes.length
  const group = await wa('groups', 'create', 'Prueba', 'work@g.us')
  assert.notEqual(group.status, 0)
  assert.match(group.stderr, /not a person/)
  const empty = await wa('groups', 'create', 'Prueba')
  assert.notEqual(empty.status, 0)
  assert.match(empty.stderr, /wa groups create/)
  assert.equal(bridge.writes.length, writes)
})

test('groups photo sends the absolute image path for a known group only', async () => {
  const image = path.join(bridge.stateRoot, 'group-photo-test.png')
  await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  try {
    const result = await wa('groups', 'photo', 'work@g.us', image)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(lastWrite().body, { jid: 'work@g.us', filePath: path.resolve(image) })
    assert.equal(lastWrite().path, '/groups/photo')
    assert.match(result.stdout, /Foto actualizada: Equipo Maspeak \(work@g\.us\)/)
    const writes = bridge.writes.length
    const notGroup = await wa('groups', 'photo', '111@lid', image)
    assert.notEqual(notGroup.status, 0)
    const notImage = await wa('groups', 'photo', 'work@g.us', cli)
    assert.notEqual(notImage.status, 0)
    assert.match(notImage.stderr, /JPG, PNG or WebP/)
    const unknown = await wa('groups', 'photo', 'other@g.us', image)
    assert.notEqual(unknown.status, 0)
    assert.equal(bridge.writes.length, writes)
  } finally {
    await fs.rm(image, { force: true })
  }
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
  assert.match(write.body.requestId, /^[A-Za-z0-9_-]{16,128}$/)
})

test('send-file gives the bridge a durable idempotency request id', async () => {
  const document = path.join(bridge.stateRoot, 'recap.pdf')
  await fs.writeFile(document, '%PDF-test')
  const result = await wa('send-file', 'Gisell', document, 'resumen')
  assert.equal(result.status, 0, result.stderr)
  const write = lastWrite()
  assert.equal(write.path, '/documents/send')
  assert.equal(write.body.caption, 'resumen')
  assert.match(write.body.requestId, /^[A-Za-z0-9_-]{16,128}$/)
})

test('calls and group-events consult the events endpoint', async () => {
  const calls = await wa('calls', 'Gisell')
  assert.equal(calls.status, 0, calls.stderr)
  assert.ok(bridge.reads.some((line) => line.includes('/events?kind=call')))

  const events = await wa('group-events', 'work@g.us')
  assert.equal(events.status, 0, events.stderr)
  assert.ok(bridge.reads.some((line) => line.includes('/events?kind=group')))
})

test('draft and trigger tools preserve literal text and scoped typed decisions', async () => {
  const text = 'Texto con "comillas", $variable y `backticks`\nOtra línea'
  const submit = await wa('automation', 'draft', 'submit', '--text', text, '--reason', 'Contexto')
  assert.equal(submit.status, 0, submit.stderr)
  assert.deepEqual(lastWrite(), { path: '/automation/draft', query: {}, body: { text, reason: 'Contexto' } })
  const decision = await wa('automation', 'draft', 'decide', 'revise', '--revision', '2', '--cursor', '13', '--reply', '13', '--reason', 'Cambios pedidos', '--text', text)
  assert.equal(decision.status, 0, decision.stderr)
  assert.deepEqual(lastWrite(), { path: '/automation/draft/decision', query: {}, body: { action: 'revise', revision: 2, cursor: 13, replyId: '13', reason: 'Cambios pedidos', text } })
  const trigger = await wa('automation', 'prompt', 'trigger', 'generic-task', '--key', 'stable-operation', '--reason', 'Caller context')
  assert.equal(trigger.status, 0, trigger.stderr)
  assert.deepEqual(lastWrite(), { path: '/automation/trigger', query: {}, body: { name: 'generic-task', key: 'stable-operation', reason: 'Caller context' } })
})

test('automation creation preserves numeric group JIDs instead of treating them as phone numbers', async () => {
  const prompt = path.join(bridge.stateRoot, 'group-prompt.md')
  await fs.writeFile(prompt, 'Reply to the authorized group.', { mode: 0o600 })
  const profiles = new AgentProfiles(path.join(bridge.stateRoot, 'data', 'agent-profiles.json'))
  await profiles.set({ name: 'group-profile', provider: 'claude', model: 'opus', promptFile: prompt })
  const fakebin = path.join(bridge.stateRoot, 'fakebin')
  await fs.mkdir(fakebin)
  await fs.writeFile(path.join(fakebin, 'claude'), '#!/bin/sh\necho "--model --no-session-persistence --tools --strict-mcp-config --system-prompt-file --output-format --effort"\n', { mode: 0o700 })
  const args = [cli, 'automation', 'prompt', 'add', 'numeric-group', '--from', '12345@g.us', '--to', '12345@g.us', '--profile', 'group-profile', '--any', '--mode', 'live', '--paused', '--yes']
  const created = await new Promise((resolve) => execFile(process.execPath, args, { encoding: 'utf8', env: { ...bridge.env, PATH: `${fakebin}:${bridge.env.PATH}` } }, (error, stdout, stderr) => resolve({ error, stdout, stderr })))
  assert.equal(created.error, null, created.stderr)
  const shown = await wa('automation', 'prompt', 'show', 'numeric-group', '--json')
  assert.equal(shown.status, 0, shown.stderr)
  const { rule } = JSON.parse(shown.stdout)
  assert.equal(rule.sourceOriginalJid, '12345@g.us')
  assert.equal(rule.destinationOriginalJid, '12345@g.us')
  assert.equal(rule.status, 'paused')
})

test('schedule add never re-encodes a LID or group as a phone number', async () => {
  const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  for (const target of ['Gisell', '111@lid', 'work@g.us']) {
    const result = await wa('schedule', 'add', '--at', at, target, 'Hola')
    assert.equal(result.status, 0, result.stderr)
  }
  const queue = JSON.parse(await fs.readFile(path.join(bridge.stateRoot, 'data', 'scheduled-messages.json'), 'utf8'))
  const added = queue.messages.slice(-3)
  assert.deepEqual(added.map((message) => [message.jid, message.phone, message.originalJid]), [
    ['111@lid', null, null],
    ['111@lid', null, null],
    ['work@g.us', null, null],
  ])
  assert.ok(added.every((message) => !JSON.stringify(message).includes('@s.whatsapp.net')))
  const shown = await wa('schedule', 'show', added[0].id)
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /Estado: scheduled/)
  assert.match(shown.stdout, /Destinatario: Gisell/)
})

test('schedule alerts can be configured and exercised without touching WhatsApp', async () => {
  const output = path.join(bridge.stateRoot, 'alert-output.txt')
  const set = await wa('schedule', 'alerts', 'set', '/bin/sh', '-c', 'cat > "$0"; printf "%s" "$1" > "$0.summary"', output)
  assert.equal(set.status, 0, set.stderr)
  const writesBefore = bridge.writes.length
  const tested = await wa('schedule', 'alerts', 'test')
  assert.equal(tested.status, 0, tested.stderr)
  assert.match(tested.stdout, /command/)
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).kind, 'scheduled_message')
  assert.match(await fs.readFile(`${output}.summary`, 'utf8'), /wa schedule show 0{32}/)
  assert.equal(bridge.writes.length, writesBefore, 'an alert test never calls the bridge')
  assert.equal((await wa('schedule', 'alerts', 'clear')).status, 0)
})

test('an explicit send reports the WhatsApp server ack and an equivalent-identity fallback', async () => {
  fixtures.postResponses['/messages/send'] = { sent: true, id: 'ACKED-ID', delivery: { jid: '598000@s.whatsapp.net', requestedJid: '111@lid', fallbackFrom: '111@lid', recipientDevices: 1, serverAckAt: 1793620804 } }
  try {
    const result = await wa('send', 'Gisell', 'hola con ack')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Sent \(ACKED-ID\) to 598000@s\.whatsapp\.net \(equivalent of 111@lid, which had no WhatsApp device\); WhatsApp server ack received\./)
  } finally {
    fixtures.postResponses['/messages/send'] = { sent: true, id: 'NEW-ID' }
  }
})

test('a request recorded before the upgrade keeps its request ID for LID and group targets', async () => {
  // 0.12.1 fingerprinted a LID or group contact by its numeric user part.
  const { PendingOutboundRequests } = await import('../src/pending-outbound-requests.js')
  const pending = new PendingOutboundRequests(path.join(bridge.stateRoot, 'data', 'pending-outbound-requests.json'))
  const lidText = 'respuesta perdida antes de actualizar'
  const before = await pending.claim({ kind: 'text', to: '111', text: lidText, mentions: [], replyToMessageId: null })
  const sent = await wa('send', 'Gisell', lidText)
  assert.equal(sent.status, 0, sent.stderr)
  assert.equal(lastWrite().body.requestId, before.requestId)

  const groupText = 'mensaje de grupo perdido'
  const groupBefore = await pending.claim({ kind: 'text', to: '120363000000000001', text: groupText, mentions: [], replyToMessageId: null })
  const groupSent = await wa('send', '120363000000000001@g.us', groupText)
  assert.equal(groupSent.status, 0, groupSent.stderr)
  assert.equal(lastWrite().body.requestId, groupBefore.requestId)
})
