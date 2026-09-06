import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import path from 'node:path'

// All writers (CLI and daemon) hold the existing cross-process control lock.
// SQLite commits control records and the append-only consultation journal in
// one transaction. Never keep a SQL transaction open across an adapter call.
export class AutomationStore {
  constructor(filename) { this.filename = `${filename}.sqlite3` }

  async open() {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const file = await fs.open(this.filename, 'a', 0o600); await file.close()
    await fs.chmod(this.filename, 0o600)
    const db = new DatabaseSync(this.filename)
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS control (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, cursor INTEGER, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_work ON journal(work_id,seq);
      CREATE INDEX IF NOT EXISTS journal_cursor ON journal(work_id,kind,cursor);`)
    return db
  }

  async load() {
    const db = await this.open()
    try {
      const meta = db.prepare("SELECT data FROM control WHERE kind='meta' AND id='version'").get()
      if (!meta) throw new Error('Automation database is incomplete; migration needs repair.')
      const state = { version: JSON.parse(meta.data), rules: [], batches: [], outbound: [] }
      for (const row of db.prepare("SELECT kind,data FROM control WHERE kind!='meta' ORDER BY rowid").all()) {
        if (!state[row.kind]) throw new Error('Unknown automation control record.')
        state[row.kind].push(JSON.parse(row.data))
      }
      return state
    } finally { db.close() }
  }

  async save(state) {
    const db = await this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec('DELETE FROM control')
      const insert = db.prepare('INSERT INTO control VALUES (?,?,?)')
      insert.run('meta', 'version', JSON.stringify(state.version))
      for (const kind of ['rules', 'batches', 'outbound']) {
        for (const record of state[kind]) insert.run(kind, record.id || record.messageId, JSON.stringify(record))
      }
      const event = db.prepare('INSERT INTO journal(work_id,key,kind,cursor,data) VALUES (?,?,?,?,?) ON CONFLICT(key) DO NOTHING')
      for (const e of state._journal || []) {
        const data = JSON.stringify(e.data)
        const previous = db.prepare('SELECT work_id,kind,data FROM journal WHERE key=?').get(e.key)
        if (previous && (previous.work_id !== e.workId || previous.kind !== e.kind || previous.data !== data)) throw new Error('Journal key reused with different content.')
        event.run(e.workId, e.key, e.kind, e.cursor ?? null, data)
      }
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch {}; throw error }
    finally { db.close() }
  }

  async events(workId, { after = 0, replies = false, kind = null, limit = 50 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Use a nonnegative cursor and limit 1–50.')
    const db = await this.open()
    try {
      const rows = kind ? db.prepare('SELECT seq,kind,cursor,data FROM journal WHERE work_id=? AND kind=? AND seq>? ORDER BY seq LIMIT ?').all(workId, kind, after, limit) : db.prepare(replies
        ? "SELECT seq,kind,cursor,data FROM journal WHERE work_id=? AND kind='reply' AND cursor>? ORDER BY cursor LIMIT ?"
        : 'SELECT seq,kind,cursor,data FROM journal WHERE work_id=? AND seq>? ORDER BY seq LIMIT ?').all(workId, after, limit)
      return rows.map((row) => ({ ...row, data: JSON.parse(row.data) }))
    } finally { db.close() }
  }
}

export function journal(state, workId, key, kind, data, cursor = null) {
  if (!state._journal) Object.defineProperty(state, '_journal', { value: [], enumerable: false })
  state._journal.push({ workId, key, kind, data, cursor })
}
