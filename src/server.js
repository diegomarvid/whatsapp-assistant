import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from 'baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const authDir = path.join(root, 'auth')
const dataDir = path.join(root, 'data')
const cachePath = path.join(dataDir, 'messages.json')
const tokenPath = path.join(dataDir, 'bridge-token')
const qrPath = path.join(dataDir, 'link-qr.png')
const MAX_MESSAGES = 3000

let connection = 'starting'
let lastError = null
let socket = null
let reconnectTimer = null
let cache = { messages: [], chats: {}, contacts: {} }
let cacheSaveQueue = Promise.resolve()

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' })

async function ensurePrivateDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
}

async function readJson(file, fallback) {
  try {
    const contents = await fs.readFile(file, 'utf8')
    try {
      return JSON.parse(contents)
    } catch (error) {
      // A prior process could have been interrupted while replacing the cache.
      // Recover the first complete JSON value rather than discarding chat history.
      let depth = 0
      let quoted = false
      let escaped = false
      let end = -1
      for (let index = 0; index < contents.length; index += 1) {
        const character = contents[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') quoted = false
          continue
        }
        if (character === '"') quoted = true
        else if (character === '{' || character === '[') depth += 1
        else if ((character === '}' || character === ']') && --depth === 0) {
          end = index + 1
          break
        }
      }
      if (end <= 0) throw error
      const recovered = JSON.parse(contents.slice(0, end))
      await fs.writeFile(file, JSON.stringify(recovered), { mode: 0o600 })
      console.warn(`Recovered a truncated local cache at ${file}`)
      return recovered
    }
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function saveCache() {
  const snapshot = JSON.stringify(cache)
  cacheSaveQueue = cacheSaveQueue.catch(() => {}).then(async () => {
    const temp = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, snapshot, { mode: 0o600 })
    await fs.rename(temp, cachePath)
  })
  return cacheSaveQueue
}

async function loadToken() {
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const token = crypto.randomBytes(32).toString('base64url')
    await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 })
    console.log(`Created local API token in ${tokenPath}`)
    return token
  }
}

function textOf(message) {
  const content = message.message || {}
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || ''
}

function safeMessage(message) {
  const jid = message.key?.remoteJid
  if (!jid) return null
  const text = textOf(message)
  return {
    id: message.key?.id || crypto.randomUUID(),
    jid,
    fromMe: Boolean(message.key?.fromMe),
    participant: message.key?.participant || null,
    timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
    text,
    type: Object.keys(message.message || {})[0] || 'unknown',
  }
}

function ingestMessages(messages) {
  let changed = false
  for (const raw of messages) {
    const message = safeMessage(raw)
    if (!message || cache.messages.some((item) => item.id === message.id && item.jid === message.jid)) continue
    cache.messages.push(message)
    cache.chats[message.jid] = {
      jid: message.jid,
      lastTimestamp: message.timestamp,
      lastMessage: message.text.slice(0, 240),
    }
    changed = true
  }
  cache.messages.sort((a, b) => a.timestamp - b.timestamp)
  if (cache.messages.length > MAX_MESSAGES) cache.messages = cache.messages.slice(-MAX_MESSAGES)
  return changed
}

function normalizeLimit(value, fallback = 50, ceiling = 200) {
  const number = Number.parseInt(value || '', 10)
  return Number.isFinite(number) ? Math.min(Math.max(number, 1), ceiling) : fallback
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body, null, 2))
}

function isAuthorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  return supplied.length === token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
}

async function connect() {
  clearTimeout(reconnectTimer)
  connection = 'connecting'
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  socket.ev.on('creds.update', saveCreds)
  socket.ev.on('messages.upsert', async ({ messages }) => {
    if (ingestMessages(messages)) await saveCache()
  })
  socket.ev.on('messaging-history.set', async ({ messages, chats, contacts }) => {
    for (const chat of chats || []) {
      if (chat.id) cache.chats[chat.id] = { ...cache.chats[chat.id], jid: chat.id, name: chat.name || null, lastTimestamp: Number(chat.conversationTimestamp || 0) }
    }
    for (const contact of contacts || []) {
      if (contact.id) cache.contacts[contact.id] = { id: contact.id, name: contact.name || contact.notify || null }
    }
    if (ingestMessages(messages || []) || (chats?.length || 0) > 0 || (contacts?.length || 0) > 0) await saveCache()
  })
  socket.ev.on('connection.update', ({ connection: next, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this QR in WhatsApp: Settings → Linked devices → Link a device\n')
      qrcodeTerminal.generate(qr, { small: true })
      QRCode.toFile(qrPath, qr, { width: 720, margin: 2, errorCorrectionLevel: 'M' })
        .then(() => fs.chmod(qrPath, 0o600))
        .then(() => console.log(`QR image saved to ${qrPath}`))
        .catch((error) => console.error('Could not save QR image:', error))
    }
    if (next === 'open') {
      connection = 'open'
      lastError = null
      fs.rm(qrPath, { force: true }).catch(() => {})
      console.log('WhatsApp bridge connected (read-only).')
    }
    if (next === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      connection = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected'
      lastError = statusCode ? `WhatsApp disconnect (${statusCode})` : 'WhatsApp disconnected'
      if (statusCode !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(() => connect().catch(console.error), 3000)
      else console.error('WhatsApp logged this bridge out. Delete auth/ and restart to link it again.')
    }
  })
}

async function main() {
  await ensurePrivateDir(authDir)
  await ensurePrivateDir(dataDir)
  cache = await readJson(cachePath, cache)
  const token = await loadToken()

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'GET') return json(response, 405, { error: 'read_only', message: 'Only GET is supported.' })
    if (url.pathname === '/health') return json(response, 200, { connection, lastError, readOnly: true, cachedMessages: cache.messages.length })
    if (!isAuthorized(request, token)) return json(response, 401, { error: 'unauthorized' })
    const limit = normalizeLimit(url.searchParams.get('limit'))
    if (url.pathname === '/chats') {
      const chats = Object.values(cache.chats)
        .map((chat) => ({ ...chat, name: cache.contacts[chat.jid]?.name || chat.name || null }))
        .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
        .slice(0, limit)
      return json(response, 200, { chats })
    }
    if (url.pathname === '/messages') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(response, 400, { error: 'missing_jid' })
      const messages = cache.messages
        .filter((message) => message.jid === jid)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
      return json(response, 200, { jid, messages })
    }
    if (url.pathname === '/search') {
      const query = url.searchParams.get('q')?.trim().toLocaleLowerCase()
      if (!query) return json(response, 400, { error: 'missing_query' })
      const messages = cache.messages
        .filter((message) => message.text.toLocaleLowerCase().includes(query))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
      return json(response, 200, { query, messages })
    }
    return json(response, 404, { error: 'not_found' })
  })
  server.listen(3847, '127.0.0.1', () => console.log('Local read-only API listening on http://127.0.0.1:3847'))
  await connect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
