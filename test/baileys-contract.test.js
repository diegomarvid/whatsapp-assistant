// The bridge's entire dependency on Baileys is this enumerable surface.
// When upgrading Baileys, this file is the first signal: a failure here means
// the wrapper's touchpoint moved, and points at exactly which one.
// Keep it in sync with AGENTS.md ("Baileys upgrade playbook") and with any new
// Baileys import added to src/.
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import makeWASocket, {
  Browsers,
  DEF_CALLBACK_PREFIX,
  buildAckStanza,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getKeyAuthor,
  generateMessageIDV2,
  generateWAMessageFromContent,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from 'baileys'

test('exposes the socket factory and session helpers the bridge is built on', () => {
  assert.equal(typeof makeWASocket, 'function')
  assert.equal(typeof useMultiFileAuthState, 'function')
  assert.equal(typeof makeCacheableSignalKeyStore, 'function')
  assert.equal(typeof fetchLatestBaileysVersion, 'function')
  assert.equal(typeof Browsers.macOS, 'function', 'extended history requests need a desktop browser profile')
})

test('exposes the media, poll and key utilities the bridge calls', () => {
  assert.equal(typeof downloadMediaMessage, 'function')
  assert.equal(typeof decryptPollVote, 'function')
  assert.equal(typeof getKeyAuthor, 'function')
})

test('keeps the disconnect semantics the reconnect logic depends on', () => {
  assert.equal(typeof DisconnectReason.loggedOut, 'number', 'loggedOut distinguishes re-link from plain reconnect')
})

test('keeps the protobuf stub types used to normalize missed calls', () => {
  const stub = proto.WebMessageInfo.StubType
  for (const name of ['CALL_MISSED_VOICE', 'CALL_MISSED_VIDEO', 'CALL_MISSED_GROUP_VOICE', 'CALL_MISSED_GROUP_VIDEO']) {
    assert.equal(typeof stub[name], 'number', `WebMessageInfo.StubType.${name} must exist`)
  }
  assert.equal(typeof proto.Message, 'function', 'quoted replies re-encode proto.Message content')
})

test('reserved automation message IDs survive Baileys message generation', () => {
  const message = generateWAMessageFromContent('test@g.us', { conversation: 'Test' }, { userJid: '123@s.whatsapp.net', messageId: '3EB0RESERVED', timestamp: new Date() })
  assert.equal(message.key.id, '3EB0RESERVED')
})

test('keeps the history-sync and recovery surface the mirror depends on', () => {
  const types = proto.HistorySync.HistorySyncType
  for (const name of ['FULL', 'RECENT', 'ON_DEMAND']) assert.equal(typeof types[name], 'number', `HistorySyncType.${name} must exist`)
  assert.equal(typeof DEFAULT_CONNECTION_CONFIG.shouldSyncHistoryMessage, 'function', 'linkOptions overrides this hook for extended retention')
  assert.equal(typeof proto.WebMessageInfo.StubType.CIPHERTEXT, 'number', 'undecryptable placeholders are marked by this stub type')
  assert.equal(typeof jidNormalizedUser, 'function', 'LID and phone aliases are normalized before merging a chat')
})

test('the socket exposes on-demand history and placeholder resend', async () => {
  // Building a socket opens a WebSocket, so check the factory's returned surface
  // in the installed source instead. wa backfill calls both methods.
  const { readFile } = await import('node:fs/promises')
  const entry = fileURLToPath(import.meta.resolve('baileys'))
  const source = await readFile(path.join(path.dirname(entry), 'Socket', 'messages-recv.js'), 'utf8')
  for (const method of ['fetchMessageHistory', 'requestPlaceholderResend']) {
    assert.match(source, new RegExp(`const ${method} = async \\(`), `${method} must still be defined by the messages socket`)
    assert.match(source, new RegExp(`\\b${method},`), `${method} must still be returned by the messages socket`)
  }
})

test('keeps the surface verified sends depend on', async () => {
  // A send only counts when the recipient has a device and the server acked
  // the exact message ID (src/verified-send.js).
  assert.equal(typeof generateMessageIDV2, 'function', 'a reserved message ID is registered before sending')
  assert.equal(jidDecode('100000000000001:3@lid').user, '100000000000001')
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const send = await readFile(path.join(lib, 'Socket', 'messages-send.js'), 'utf8')
  assert.match(send, /const getUSyncDevices = async \(jids, useCache, ignoreZeroDevices\)/, 'getUSyncDevices(jids, useCache, ignoreZeroDevices) enumerates recipient devices')
  assert.match(send, /\bgetUSyncDevices,/, 'getUSyncDevices must still be returned by the messages socket')
  assert.match(send, /messageId: generateMessageIDV2\(sock\.user\?\.id\),\s*\.\.\.options/, 'sendMessage must honor a caller-provided messageId')
  assert.match(send, /upload: waUploadToServer,[\s\S]{0,200}\.\.\.options\s*\}\);/, 'per-call options must override the uploader, so an upload failure is known to precede the relay')
  assert.match(send, /\bwaUploadToServer,/, 'waUploadToServer must still be returned by the messages socket')
  const recv = await readFile(path.join(lib, 'Socket', 'messages-recv.js'), 'utf8')
  assert.match(recv, /ws\.on\('CB:ack,class:message'/, 'server acks for sent messages arrive as CB:ack,class:message frames')
  const socket = await readFile(path.join(lib, 'Socket', 'socket.js'), 'utf8')
  assert.match(socket, /return \{\s*type: 'md',\s*ws,\s*ev,/, 'the socket exposes its frame emitter as ws')
  assert.match(socket, /get user\(\) \{\s*return authState\.creds\.me;/, 'socket.user carries the own PN and LID')
  assert.match(socket, /ws\.emit\(`\$\{DEF_CALLBACK_PREFIX\}\$\{l0\},\$\{key\}:\$\{l1\[key\]\}`, frame\)/, 'the socket emits tag,attr:value callback events for every frame')
  const mapping = await readFile(path.join(lib, 'Signal', 'lid-mapping.js'), 'utf8')
  for (const method of ['getPNForLID', 'getLIDForPN']) assert.match(mapping, new RegExp(`async ${method}\\(`), `${method} resolves LID ↔ phone equivalents`)
})

test('the socket still creates groups and reports their participants', async () => {
  // wa groups create calls groupCreate(subject, participants) and reads the
  // returned metadata's id, subject and participants (id, phoneNumber, lid, admin).
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const groups = await readFile(path.join(lib, 'Socket', 'groups.js'), 'utf8')
  assert.match(groups, /groupCreate: async \(subject, participants\) =>/, 'groupCreate(subject, participants) must still be returned by the groups socket')
  assert.match(groups, /return extractGroupMetadata\(result\);/, 'groupCreate must still return the created group metadata')
  for (const field of ['id: attrs.jid,', 'phoneNumber:', 'lid:', 'admin: (attrs.type || null)']) assert.ok(groups.includes(field), `group participants must still carry ${field}`)
})

test('the socket still sets a group photo through the bundled image library', async () => {
  // wa groups photo calls updateProfilePicture(groupJid, buffer); Baileys
  // crops and scales it with sharp, which this package installs.
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const chats = await readFile(path.join(lib, 'Socket', 'chats.js'), 'utf8')
  assert.match(chats, /const updateProfilePicture = async \(jid, content, dimensions\) =>/, 'updateProfilePicture(jid, content) must still be defined by the chats socket')
  assert.match(chats, /\bupdateProfilePicture,/, 'updateProfilePicture must still be returned by the chats socket')
  const media = await readFile(path.join(lib, 'Utils', 'messages-media.js'), 'utf8')
  assert.match(media, /import\('sharp'\)/, 'Baileys must still load sharp for profile pictures')
  const sharp = (await import('sharp')).default
  const square = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#0a7' } }).png().toBuffer()
  assert.ok(square.length > 0, 'sharp must load in this installation')
})

test('the socket still sets who can add participants to a group', async () => {
  // wa groups create and wa groups member-add call groupMemberAddMode(jid,
  // 'all_member_add' | 'admin_add'); groups detail reads metadata.memberAddMode.
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const groups = await readFile(path.join(lib, 'Socket', 'groups.js'), 'utf8')
  assert.match(groups, /groupMemberAddMode: async \(jid, mode\) =>/, 'groupMemberAddMode(jid, mode) must still be returned by the groups socket')
  assert.match(groups, /tag: 'member_add_mode', attrs: \{\}, content: mode/, 'member_add_mode must still carry the mode as content')
  assert.match(groups, /memberAddMode = getBinaryNodeChildString\(group, 'member_add_mode'\) === 'all_member_add'/, 'group metadata must still expose memberAddMode')
})


test('the bridge still has to ack <status> stanzas itself (src/status-stanza-ack.js)', async () => {
  // WhatsApp delivers contacts' status updates as a top-level <status> stanza
  // to some accounts. Baileys rc14 never acks it: the offline queue stalls and
  // the stream ends every ~50 min (WhiskeySockets/Baileys#2858, PR #2866).
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const recv = await readFile(path.join(lib, 'Socket', 'messages-recv.js'), 'utf8')
  assert.doesNotMatch(recv, /CB:status/, 'Baileys now handles <status> stanzas: delete src/status-stanza-ack.js, its wiring in src/server.js and this test')
  // The bridge's ack relies on the public frame emitter, sendNode and Baileys' own ack builder.
  assert.equal(DEF_CALLBACK_PREFIX, 'CB:', 'frames are emitted as CB:<tag>')
  const socket = await readFile(path.join(lib, 'Socket', 'socket.js'), 'utf8')
  assert.match(socket, /ws\.emit\(`\$\{DEF_CALLBACK_PREFIX\}\$\{l0\}`, frame\)/, 'every frame must still be emitted under its plain tag')
  assert.match(socket, /\bsendNode,\n/, 'sendNode must still be returned by the socket')
  assert.deepEqual(
    buildAckStanza({ tag: 'status', attrs: { id: 'A5', from: 'status@broadcast', participant: '1@lid', type: 'media', offline: '1' } }),
    { tag: 'ack', attrs: { id: 'A5', to: 'status@broadcast', class: 'status', participant: '1@lid', type: 'media' } },
  )
})

test('keeps the stream-error shape link health reads', async () => {
  // A <stream:error> whose child is an <ack> means the server waited ~50 min
  // for an ack the bridge never sent; link-health counts these.
  const { readFile } = await import('node:fs/promises')
  const lib = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
  const socket = await readFile(path.join(lib, 'Socket', 'socket.js'), 'utf8')
  assert.match(socket, /new Boom\(`Stream Errored \(\$\{reason\}\)`, \{ statusCode, data: reasonNode \|\| node \}\)/, 'the close error must still carry the stream:error child as data')
  assert.match(socket, /ws\.on\('CB:ib,,offline', \(node\) => \{[\s\S]{0,400}receivedPendingNotifications: true/, 'the end of the offline queue must still be reported as receivedPendingNotifications')
})
