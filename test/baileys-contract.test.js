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
  const recv = await readFile(path.join(lib, 'Socket', 'messages-recv.js'), 'utf8')
  assert.match(recv, /ws\.on\('CB:ack,class:message'/, 'server acks for sent messages arrive as CB:ack,class:message frames')
  const socket = await readFile(path.join(lib, 'Socket', 'socket.js'), 'utf8')
  assert.match(socket, /return \{\s*type: 'md',\s*ws,\s*ev,/, 'the socket exposes its frame emitter as ws')
  assert.match(socket, /get user\(\) \{\s*return authState\.creds\.me;/, 'socket.user carries the own PN and LID')
  assert.match(socket, /ws\.emit\(`\$\{DEF_CALLBACK_PREFIX\}\$\{l0\},\$\{key\}:\$\{l1\[key\]\}`, frame\)/, 'the socket emits tag,attr:value callback events for every frame')
  const mapping = await readFile(path.join(lib, 'Signal', 'lid-mapping.js'), 'utf8')
  for (const method of ['getPNForLID', 'getLIDForPN']) assert.match(mapping, new RegExp(`async ${method}\\(`), `${method} resolves LID ↔ phone equivalents`)
})
