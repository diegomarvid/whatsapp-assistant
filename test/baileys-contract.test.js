// The bridge's entire dependency on Baileys is this enumerable surface.
// When upgrading Baileys, this file is the first signal: a failure here means
// the wrapper's touchpoint moved, and points at exactly which one.
// Keep it in sync with AGENTS.md ("Baileys upgrade playbook") and with any new
// Baileys import added to src/.
import assert from 'node:assert/strict'
import test from 'node:test'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getKeyAuthor,
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
