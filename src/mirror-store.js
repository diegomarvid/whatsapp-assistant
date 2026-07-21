import { DatabaseSync } from 'node:sqlite'

function parse(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeCache(cache) {
  return {
    messages: Array.isArray(cache?.messages) ? cache.messages : [],
    chats: cache?.chats && typeof cache.chats === 'object' ? cache.chats : {},
    contacts: cache?.contacts && typeof cache.contacts === 'object' ? cache.contacts : {},
    groupEvents: Array.isArray(cache?.groupEvents) ? cache.groupEvents : [],
    callEvents: Array.isArray(cache?.callEvents) ? cache.callEvents : [],
    sync: cache?.sync && typeof cache.sync === 'object' ? cache.sync : {},
  }
}

export class MirrorStore {
  constructor(filename, { retentionDays = 7 } = {}) {
    this.retentionSeconds = retentionDays * 24 * 60 * 60
    this.database = new DatabaseSync(filename)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS messages (
        jid TEXT NOT NULL,
        id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages (jid, timestamp DESC);
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mirror_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_contents (
        jid TEXT NOT NULL,
        id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS message_contents_by_time ON message_contents (timestamp);
      CREATE TABLE IF NOT EXISTS poll_secrets (
        jid TEXT NOT NULL,
        id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        secret BLOB NOT NULL,
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS poll_secrets_by_time ON poll_secrets (timestamp);
      CREATE TABLE IF NOT EXISTS event_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        jid TEXT,
        message_id TEXT,
        message_timestamp INTEGER,
        message_type TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS event_audit_by_received_at ON event_audit (received_at DESC);
      CREATE TABLE IF NOT EXISTS retry_cache (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS retry_cache_expiry ON retry_cache (expires_at);
    `)
    this.upsertMessage = this.database.prepare('INSERT INTO messages (jid, id, timestamp, payload) VALUES (?, ?, ?, ?) ON CONFLICT(jid, id) DO UPDATE SET timestamp = excluded.timestamp, payload = excluded.payload')
    this.upsertChat = this.database.prepare('INSERT INTO chats (jid, payload) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET payload = excluded.payload')
    this.upsertContact = this.database.prepare('INSERT INTO contacts (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
    this.upsertMeta = this.database.prepare('INSERT INTO mirror_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.upsertMessageContent = this.database.prepare('INSERT INTO message_contents (jid, id, timestamp, payload) VALUES (?, ?, ?, ?) ON CONFLICT(jid, id) DO UPDATE SET timestamp = excluded.timestamp, payload = excluded.payload')
    this.getMessageContent = this.database.prepare('SELECT payload FROM message_contents WHERE jid = ? AND id = ?')
    this.upsertPollSecret = this.database.prepare('INSERT INTO poll_secrets (jid, id, timestamp, secret) VALUES (?, ?, ?, ?) ON CONFLICT(jid, id) DO UPDATE SET timestamp = excluded.timestamp, secret = excluded.secret')
    this.getPollSecret = this.database.prepare('SELECT secret FROM poll_secrets WHERE jid = ? AND id = ?')
    this.insertAuditEvent = this.database.prepare('INSERT INTO event_audit (received_at, event, jid, message_id, message_timestamp, message_type, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    this.getRetryValue = this.database.prepare('SELECT value FROM retry_cache WHERE namespace = ? AND key = ? AND expires_at >= ?')
    this.upsertRetryValue = this.database.prepare('INSERT INTO retry_cache (namespace, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
    this.deleteRetryValue = this.database.prepare('DELETE FROM retry_cache WHERE namespace = ? AND key = ?')
  }

  load() {
    const messages = this.database.prepare('SELECT payload FROM messages ORDER BY timestamp').all().map(({ payload }) => parse(payload, null)).filter(Boolean)
    const chats = Object.fromEntries(this.database.prepare('SELECT jid, payload FROM chats').all().map(({ jid, payload }) => [jid, parse(payload, {})]))
    const contacts = Object.fromEntries(this.database.prepare('SELECT id, payload FROM contacts').all().map(({ id, payload }) => [id, parse(payload, {})]))
    const sync = parse(this.database.prepare("SELECT value FROM mirror_meta WHERE key = 'sync'").get()?.value, {})
    const groupEvents = parse(this.database.prepare("SELECT value FROM mirror_meta WHERE key = 'group_events'").get()?.value, [])
    const callEvents = parse(this.database.prepare("SELECT value FROM mirror_meta WHERE key = 'call_events'").get()?.value, [])
    return normalizeCache({ messages, chats, contacts, groupEvents, callEvents, sync })
  }

  isEmpty() {
    return this.database.prepare('SELECT 1 AS present FROM messages LIMIT 1').get() === undefined
  }

  persist(cache, nowSeconds = Math.floor(Date.now() / 1000)) {
    const state = normalizeCache(cache)
    const cutoff = nowSeconds - this.retentionSeconds
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const message of state.messages) {
        if (Number(message.timestamp) >= cutoff) this.upsertMessage.run(message.jid, message.id, message.timestamp, JSON.stringify(message))
      }
      for (const [jid, chat] of Object.entries(state.chats)) this.upsertChat.run(jid, JSON.stringify(chat))
      for (const [id, contact] of Object.entries(state.contacts)) this.upsertContact.run(id, JSON.stringify(contact))
      this.upsertMeta.run('group_events', JSON.stringify(state.groupEvents.filter((event) => Number(event.timestamp) >= cutoff)))
      this.upsertMeta.run('call_events', JSON.stringify(state.callEvents.filter((event) => Number(event.timestamp) >= cutoff)))
      this.upsertMeta.run('sync', JSON.stringify(state.sync))
      this.database.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff)
      this.database.prepare('DELETE FROM message_contents WHERE timestamp < ?').run(cutoff)
      this.database.prepare('DELETE FROM poll_secrets WHERE timestamp < ?').run(cutoff)
      this.database.prepare('DELETE FROM event_audit WHERE received_at < ?').run(cutoff)
      this.database.prepare('DELETE FROM retry_cache WHERE expires_at < ?').run(nowSeconds)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  saveMessageContent({ jid, id, timestamp, payload }) {
    if (!jid || !id || !payload) return
    this.upsertMessageContent.run(jid, id, Number(timestamp) || Math.floor(Date.now() / 1000), payload)
  }

  loadMessageContent({ jid, id }) {
    const payload = this.getMessageContent.get(jid, id)?.payload
    return payload ? Buffer.from(payload) : null
  }

  savePollSecret({ jid, id, timestamp, secret }) {
    if (!jid || !id || !secret) return
    this.upsertPollSecret.run(jid, id, Number(timestamp) || Math.floor(Date.now() / 1000), Buffer.from(secret))
  }

  loadPollSecret({ jid, id }) {
    const secret = this.getPollSecret.get(jid, id)?.secret
    return secret ? Buffer.from(secret) : null
  }

  recordEvent({ receivedAt = Math.floor(Date.now() / 1000), event, jid = null, messageId = null, messageTimestamp = null, messageType = null, detail = null }) {
    this.insertAuditEvent.run(receivedAt, event, jid, messageId, messageTimestamp, messageType, detail ? JSON.stringify(detail) : null)
  }

  createRetryCache(namespace, { ttlSeconds = 60 * 60 } = {}) {
    return {
      get: (key) => {
        const now = Math.floor(Date.now() / 1000)
        const entry = this.getRetryValue.get(namespace, String(key), now)
        return entry ? parse(entry.value, undefined) : undefined
      },
      set: (key, value) => {
        const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds
        this.upsertRetryValue.run(namespace, String(key), JSON.stringify(value), expiresAt)
      },
      del: (key) => this.deleteRetryValue.run(namespace, String(key)),
      flushAll: () => this.database.prepare('DELETE FROM retry_cache WHERE namespace = ?').run(namespace),
    }
  }

  close() {
    this.database.close()
  }
}
