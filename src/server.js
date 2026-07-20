import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deserialize, serialize } from 'node:v8'
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
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
const audioEnvelopeDir = path.join(dataDir, 'audio-envelopes')
const downloadedAudioDir = path.join(dataDir, 'audio')
// Keep the assistant useful for current conversations without retaining a full
// archive of the account. WhatsApp decides the exact recent-sync window.
const MAX_MESSAGES = 10000
const RETENTION_DAYS = 30

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
    audioRef: null,
  }
}

async function cacheAudioEnvelope(rawMessage, message) {
  if (message.type !== 'audioMessage') return
  const filename = `${message.id}.bin`
  const target = path.join(audioEnvelopeDir, filename)
  try {
    await fs.access(target)
  } catch {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, serialize(rawMessage), { mode: 0o600 })
    await fs.rename(temp, target)
  }
  message.audioRef = filename
}

async function ingestMessages(messages) {
  let changed = false
  for (const raw of messages) {
    const message = safeMessage(raw)
    if (!message) continue
    const existing = cache.messages.find((item) => item.id === message.id && item.jid === message.jid)
    if (existing) {
      if (message.type === 'audioMessage' && !existing.audioRef) {
        try {
          await cacheAudioEnvelope(raw, existing)
          changed = true
        } catch (error) {
          logger.warn({ err: error, messageId: message.id }, 'Could not retain replayed audio envelope')
        }
      }
      continue
    }
    try {
      await cacheAudioEnvelope(raw, message)
    } catch (error) {
      logger.warn({ err: error, messageId: message.id }, 'Could not retain audio envelope')
    }
    cache.messages.push(message)
    cache.chats[message.jid] = {
      jid: message.jid,
      lastTimestamp: message.timestamp,
      lastMessage: message.text.slice(0, 240),
    }
    changed = true
  }
  pruneMessages()
  if (cache.messages.length > MAX_MESSAGES) cache.messages = cache.messages.slice(-MAX_MESSAGES)
  return changed
}

async function prunePrivateMedia() {
  const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000)
  for (const directory of [audioEnvelopeDir, downloadedAudioDir]) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(directory, entry.name)
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file, { force: true })
    }
  }
}

async function downloadAudio(message) {
  if (!socket?.updateMediaMessage) throw new Error('WhatsApp is not connected.')
  if (!message.audioRef) throw new Error('This audio was received before media capture was enabled.')
  const raw = deserialize(await fs.readFile(path.join(audioEnvelopeDir, message.audioRef)))
  const bytes = await downloadMediaMessage(raw, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
  const filename = `${message.id}.ogg`
  const target = path.join(downloadedAudioDir, filename)
  await fs.writeFile(target, bytes, { mode: 0o600 })
  return { filename, path: target }
}

function pruneMessages() {
  const cutoff = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60)
  cache.messages = cache.messages.filter((message) => message.timestamp >= cutoff)
  cache.messages.sort((a, b) => a.timestamp - b.timestamp)
}

function normalizeLimit(value, fallback = 50, ceiling = 200) {
  const number = Number.parseInt(value || '', 10)
  return Number.isFinite(number) ? Math.min(Math.max(number, 1), ceiling) : fallback
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body, null, 2))
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
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
    if (await ingestMessages(messages)) await saveCache()
  })
  socket.ev.on('messaging-history.set', async ({ messages, chats, contacts }) => {
    for (const chat of chats || []) {
      if (chat.id) cache.chats[chat.id] = { ...cache.chats[chat.id], jid: chat.id, name: chat.name || null, lastTimestamp: Number(chat.conversationTimestamp || 0) }
    }
    for (const contact of contacts || []) {
      if (contact.id) cache.contacts[contact.id] = { id: contact.id, name: contact.name || contact.notify || null }
    }
    if (await ingestMessages(messages || []) || (chats?.length || 0) > 0 || (contacts?.length || 0) > 0) await saveCache()
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
  await ensurePrivateDir(audioEnvelopeDir)
  await ensurePrivateDir(downloadedAudioDir)
  cache = await readJson(cachePath, cache)
  pruneMessages()
  await saveCache()
  await prunePrivateMedia()
  const token = await loadToken()

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const isAudioDownload = request.method === 'POST' && url.pathname === '/audio/download'
    const isMessageSend = request.method === 'POST' && url.pathname === '/messages/send'
    const isDocumentSend = request.method === 'POST' && url.pathname === '/documents/send'
    if (request.method !== 'GET' && !isAudioDownload && !isMessageSend && !isDocumentSend) return json(response, 405, { error: 'method_not_allowed' })
    if (url.pathname === '/health') return json(response, 200, { connection, lastError, allowExplicitSend: true, cachedMessages: cache.messages.length })
    if (!isAuthorized(request, token)) return json(response, 401, { error: 'unauthorized' })
    if (isMessageSend) {
      requestBody(request).then(async ({ jid, text }) => {
        if (!jid || typeof text !== 'string' || !text.trim()) return json(response, 400, { error: 'invalid_message' })
        if (!socket?.sendMessage) return json(response, 503, { error: 'whatsapp_not_connected' })
        const result = await socket.sendMessage(jid, { text: text.trim() })
        json(response, 200, { sent: true, id: result?.key?.id || null })
      }).catch((error) => json(response, 422, { error: 'send_failed', message: error.message }))
      return
    }
    if (isDocumentSend) {
      requestBody(request).then(async ({ jid, filePath, caption }) => {
        if (!jid || typeof filePath !== 'string' || !filePath) return json(response, 400, { error: 'invalid_document' })
        if (caption !== undefined && typeof caption !== 'string') return json(response, 400, { error: 'invalid_caption' })
        if (!socket?.sendMessage) return json(response, 503, { error: 'whatsapp_not_connected' })
        const document = await fs.readFile(filePath)
        const result = await socket.sendMessage(jid, {
          document,
          fileName: path.basename(filePath),
          mimetype: 'application/pdf',
          caption: caption?.trim() || undefined,
        })
        json(response, 200, { sent: true, id: result?.key?.id || null })
      }).catch((error) => json(response, 422, { error: 'document_send_failed', message: error.message }))
      return
    }
    if (isAudioDownload) {
      const jid = url.searchParams.get('jid')
      const messageId = url.searchParams.get('messageId')
      const message = cache.messages.find((item) => item.jid === jid && item.id === messageId && item.type === 'audioMessage')
      if (!message) return json(response, 404, { error: 'audio_not_found' })
      downloadAudio(message)
        .then((audio) => json(response, 200, { audio }))
        .catch((error) => json(response, 422, { error: 'audio_download_failed', message: error.message }))
      return
    }
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
