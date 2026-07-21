import { DatabaseSync } from 'node:sqlite'

function parse(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeCache(cache) {
  return {
    messages: Array.isArray(cache?.messages) ? cache.messages : [],
    chats: cache?.chats && typeof cache.chats === 'object' ? cache.chats : {},
    contacts: cache?.contacts && typeof cache.contacts === 'object' ? cache.contacts : {},
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
    `)
    this.upsertMessage = this.database.prepare('INSERT INTO messages (jid, id, timestamp, payload) VALUES (?, ?, ?, ?) ON CONFLICT(jid, id) DO UPDATE SET timestamp = excluded.timestamp, payload = excluded.payload')
    this.upsertChat = this.database.prepare('INSERT INTO chats (jid, payload) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET payload = excluded.payload')
    this.upsertContact = this.database.prepare('INSERT INTO contacts (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
    this.upsertMeta = this.database.prepare('INSERT INTO mirror_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  }

  load() {
    const messages = this.database.prepare('SELECT payload FROM messages ORDER BY timestamp').all().map(({ payload }) => parse(payload, null)).filter(Boolean)
    const chats = Object.fromEntries(this.database.prepare('SELECT jid, payload FROM chats').all().map(({ jid, payload }) => [jid, parse(payload, {})]))
    const contacts = Object.fromEntries(this.database.prepare('SELECT id, payload FROM contacts').all().map(({ id, payload }) => [id, parse(payload, {})]))
    const sync = parse(this.database.prepare("SELECT value FROM mirror_meta WHERE key = 'sync'").get()?.value, {})
    return normalizeCache({ messages, chats, contacts, sync })
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
      this.upsertMeta.run('sync', JSON.stringify(state.sync))
      this.database.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.database.close()
  }
}
