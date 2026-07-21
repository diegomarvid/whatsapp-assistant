import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
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
import { mimeTypeForFile } from './file-mime.js'
import { safeMessage } from './message-normalizer.js'
import { coverageForChat, RECENT_RETENTION_DAYS } from './chat-coverage.js'
import { MirrorStore } from './mirror-store.js'
import { paths } from './runtime-paths.js'

const { authDir, dataDir } = paths
const cachePath = path.join(dataDir, 'messages.json')
const mirrorPath = path.join(dataDir, 'mirror.sqlite')
const tokenPath = path.join(dataDir, 'bridge-token')
const qrPath = path.join(dataDir, 'link-qr.png')
const audioEnvelopeDir = path.join(dataDir, 'audio-envelopes')
const downloadedAudioDir = path.join(dataDir, 'audio')
const imageEnvelopeDir = path.join(dataDir, 'image-envelopes')
const downloadedImageDir = path.join(dataDir, 'images')
const documentEnvelopeDir = path.join(dataDir, 'document-envelopes')
const downloadedDocumentDir = path.join(dataDir, 'documents')
// Keep only recent operational context. The bridge must never become a private
// archive of the whole account.
const MAX_MESSAGES = 10000
const RETENTION_DAYS = RECENT_RETENTION_DAYS

let connection = 'starting'
let lastError = null
let socket = null
let reconnectTimer = null
let cache = { messages: [], chats: {}, contacts: {}, sync: {} }
let cacheSaveQueue = Promise.resolve()
let lastLiveMessageAt = null
let mirrorStore = null
let msgRetryCounterCache = null

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' })

// libsignal currently logs full session objects through console.info when it
// rotates a ratchet. Those objects include key material, so never let them
// reach the LaunchAgent logs.
const consoleInfo = console.info.bind(console)
console.info = (...args) => {
  if (args[0] === 'Closing session:') {
    logger.debug('Suppressed sensitive libsignal session rotation log')
    return
  }
  consoleInfo(...args)
}

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
  cacheSaveQueue = cacheSaveQueue.catch(() => {}).then(async () => {
    mirrorStore.persist(cache)
  })
  return cacheSaveQueue
}

function ensureCacheShape() {
  cache.messages = Array.isArray(cache.messages) ? cache.messages : []
  cache.chats = cache.chats && typeof cache.chats === 'object' ? cache.chats : {}
  cache.contacts = cache.contacts && typeof cache.contacts === 'object' ? cache.contacts : {}
  cache.sync = cache.sync && typeof cache.sync === 'object' ? cache.sync : {}
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function markBridgeProcessStarted() {
  // The durable mirror survives restarts. Connection health is observable but
  // never requires the user to link the companion again.
  cache.sync = {
    ...cache.sync,
    observerStartedAt: nowSeconds(),
    ingestionHealthy: true,
    lastIngestError: null,
  }
}

function chatCoverage(jid) {
  return coverageForChat({
    chat: cache.chats[jid],
    messages: cache.messages.filter((message) => message.jid === jid),
    connection,
    sync: cache.sync,
  })
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

async function cacheImageEnvelope(rawMessage, message) {
  if (message.type !== 'imageMessage') return
  const filename = `${message.id}.bin`
  const target = path.join(imageEnvelopeDir, filename)
  try {
    await fs.access(target)
  } catch {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, serialize(rawMessage), { mode: 0o600 })
    await fs.rename(temp, target)
  }
  message.imageRef = filename
}

async function cacheDocumentEnvelope(rawMessage, message) {
  if (message.type !== 'documentMessage') return
  const filename = `${message.id}.bin`
  const target = path.join(documentEnvelopeDir, filename)
  try { await fs.access(target) } catch {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, serialize(rawMessage), { mode: 0o600 })
    await fs.rename(temp, target)
  }
  message.documentRef = filename
}

function auditMessageEvent(raw, event, detail = null) {
  try {
    mirrorStore?.recordEvent({
      event,
      jid: raw?.key?.remoteJid || null,
      messageId: raw?.key?.id || null,
      messageTimestamp: Number(raw?.messageTimestamp || 0) || null,
      messageType: Object.keys(raw?.message || {})[0] || null,
      detail,
    })
  } catch (error) {
    // Auditing must never interfere with WhatsApp message delivery.
    logger.warn({ err: error }, 'Could not record WhatsApp event audit')
  }
}

function retainMessageContent(raw) {
  const jid = raw?.key?.remoteJid
  const id = raw?.key?.id
  if (!jid || !id || !raw?.message || Object.keys(raw.message).length === 0) return
  mirrorStore?.saveMessageContent({
    jid,
    id,
    timestamp: Number(raw.messageTimestamp || nowSeconds()),
    payload: serialize(raw.message),
  })
}

async function getMessageFromMirror(key) {
  const jid = key?.remoteJid
  const id = key?.id
  if (!jid || !id) return undefined
  try {
    const payload = mirrorStore?.loadMessageContent({ jid, id })
    return payload ? deserialize(payload) : undefined
  } catch (error) {
    auditMessageEvent({ key }, 'message.content_load_failed', { error: error.message })
    logger.warn({ err: error, jid, messageId: id }, 'Could not load message content for Baileys retry')
    return undefined
  }
}

async function resolveCurrentJid(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return jid
  const mapping = socket?.signalRepository?.lidMapping
  if (!mapping?.getLIDForPN) return jid
  try {
    return (await mapping.getLIDForPN(jid)) || jid
  } catch (error) {
    logger.warn({ err: error, jid }, 'Could not resolve current WhatsApp LID for phone JID')
    return jid
  }
}

function mergeIncomingMessage(existing, incoming) {
  const refs = {
    audioRef: existing.audioRef,
    imageRef: existing.imageRef,
    documentRef: existing.documentRef,
  }
  const hasUsableContent = incoming.type !== 'unknown' || incoming.text || incoming.reactionText
  if (hasUsableContent) Object.assign(existing, incoming)
  Object.assign(existing, refs)
}

async function ingestMessages(messages, source = 'history') {
  let changed = false
  for (const raw of messages) {
    try {
      auditMessageEvent(raw, `messages.${source}`)
      retainMessageContent(raw)
      const message = safeMessage(raw, { source })
      if (!message) continue
      const existing = cache.messages.find((item) => item.id === message.id && item.jid === message.jid)
      if (existing) {
      mergeIncomingMessage(existing, message)
      if (message.pushName && !existing.pushName) {
        existing.pushName = message.pushName
        const previousChat = cache.chats[message.jid] || { jid: message.jid }
        if (!previousChat.name) cache.chats[message.jid] = { ...previousChat, name: message.pushName }
        changed = true
      }
      if (source === 'live' && existing.source !== 'live') {
        existing.source = 'live'
        existing.capturedAt = message.capturedAt
        changed = true
      }
      if (source === 'live') {
        const previousChat = cache.chats[message.jid] || { jid: message.jid }
        cache.chats[message.jid] = { ...previousChat, lastObservedLiveAt: nowSeconds(), lastObservedLiveMessageId: message.id }
        changed = true
      }
      if (message.type === 'audioMessage' && !existing.audioRef) {
        try {
          await cacheAudioEnvelope(raw, existing)
          changed = true
        } catch (error) {
          logger.warn({ err: error, messageId: message.id }, 'Could not retain replayed audio envelope')
        }
      }
      if (message.type === 'imageMessage' && !existing.imageRef) {
        try {
          await cacheImageEnvelope(raw, existing)
          changed = true
        } catch (error) {
          logger.warn({ err: error, messageId: message.id }, 'Could not retain replayed image envelope')
        }
      }
      if (message.type === 'documentMessage' && !existing.documentRef) {
        try { await cacheDocumentEnvelope(raw, existing); changed = true } catch (error) { logger.warn({ err: error, messageId: message.id }, 'Could not retain replayed document envelope') }
      }
        continue
      }
      try {
        await cacheAudioEnvelope(raw, message)
      } catch (error) {
        logger.warn({ err: error, messageId: message.id }, 'Could not retain audio envelope')
      }
      try {
        await cacheImageEnvelope(raw, message)
      } catch (error) {
        logger.warn({ err: error, messageId: message.id }, 'Could not retain image envelope')
      }
      try { await cacheDocumentEnvelope(raw, message) } catch (error) { logger.warn({ err: error, messageId: message.id }, 'Could not retain document envelope') }
      cache.messages.push(message)
      const previousChat = cache.chats[message.jid] || {}
      cache.chats[message.jid] = {
        ...previousChat,
        jid: message.jid,
        name: message.pushName || cache.contacts[message.jid]?.name || previousChat.name || null,
        lastTimestamp: message.timestamp,
        lastMessage: message.text.slice(0, 240),
        remoteLastTimestamp: Math.max(Number(previousChat.remoteLastTimestamp || 0), message.timestamp),
        lastObservedLiveAt: source === 'live' ? nowSeconds() : previousChat.lastObservedLiveAt || null,
        lastObservedLiveMessageId: source === 'live' ? message.id : previousChat.lastObservedLiveMessageId || null,
      }
      changed = true
    } catch (error) {
      auditMessageEvent(raw, 'message.ingest_failed', { error: error.message })
      logger.error({ err: error, messageId: raw?.key?.id, jid: raw?.key?.remoteJid }, 'Skipped malformed WhatsApp payload; bridge remains connected')
    }
  }
  pruneMessages()
  if (cache.messages.length > MAX_MESSAGES) cache.messages = cache.messages.slice(-MAX_MESSAGES)
  return changed
}

async function prunePrivateMedia() {
  const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000)
  for (const directory of [audioEnvelopeDir, downloadedAudioDir, imageEnvelopeDir, downloadedImageDir, documentEnvelopeDir, downloadedDocumentDir]) {
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

function imageExtension(mimetype) {
  if (mimetype === 'image/png') return 'png'
  if (mimetype === 'image/webp') return 'webp'
  return 'jpg'
}

async function downloadImage(message) {
  if (!socket?.updateMediaMessage) throw new Error('WhatsApp is not connected.')
  if (!message.imageRef) throw new Error('This image was received before image capture was enabled. Ask the sender to forward it again.')
  const raw = deserialize(await fs.readFile(path.join(imageEnvelopeDir, message.imageRef)))
  const bytes = await downloadMediaMessage(raw, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
  const filename = `${message.id}.${imageExtension(message.imageMimetype)}`
  const target = path.join(downloadedImageDir, filename)
  await fs.writeFile(target, bytes, { mode: 0o600 })
  return { filename, path: target, mimetype: message.imageMimetype || 'image/jpeg' }
}

async function downloadDocument(message) {
  if (!socket?.updateMediaMessage) throw new Error('WhatsApp is not connected.')
  if (!message.documentRef) throw new Error('This document was received before document capture was enabled. Ask the sender to forward it again.')
  const raw = deserialize(await fs.readFile(path.join(documentEnvelopeDir, message.documentRef)))
  const bytes = await downloadMediaMessage(raw, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
  const safeName = (message.documentName || `${message.id}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_')
  const target = path.join(downloadedDocumentDir, `${message.id}-${safeName}`)
  await fs.writeFile(target, bytes, { mode: 0o600 })
  return { filename: path.basename(target), path: target, mimetype: message.documentMimetype || 'application/octet-stream' }
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

function listenLocal(server) {
  return new Promise((resolve, reject) => {
    const onStartupError = (error) => {
      server.off('error', onStartupError)
      reject(error)
    }
    server.once('error', onStartupError)
    server.listen(3847, '127.0.0.1', () => {
      server.off('error', onStartupError)
      server.on('error', (error) => {
        lastError = `Local API error: ${error.message}`
        logger.error({ err: error }, 'Local WhatsApp API error; observer remains alive')
      })
      console.log('Local WhatsApp API listening on http://127.0.0.1:3847')
      resolve()
    })
  })
}

function installGracefulShutdown(server) {
  let stopping = false
  const shutdown = (signal) => {
    if (stopping) return
    stopping = true
    connection = 'stopping'
    clearTimeout(reconnectTimer)
    Promise.resolve()
      .then(() => saveCache())
      .catch((error) => logger.error({ err: error }, 'Could not persist mirror during shutdown'))
      .finally(() => {
        server.close(() => {
          mirrorStore?.close()
          process.exit(0)
        })
        setTimeout(() => process.exit(0), 5000).unref()
      })
    logger.info({ signal }, 'Stopping WhatsApp observer cleanly')
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
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

async function applyMessageUpdates(updates) {
  let changed = false
  for (const { key, update } of updates || []) {
    const jid = key?.remoteJid
    const id = key?.id
    if (!jid || !id) continue
    try {
      mirrorStore?.recordEvent({
        event: 'messages.update',
        jid,
        messageId: id,
        messageTimestamp: Number(update?.messageTimestamp || 0) || null,
        messageType: Object.keys(update?.message || {})[0] || null,
        detail: {
          hasContent: Boolean(update?.message && Object.keys(update.message).length),
          stubType: update?.messageStubType ?? null,
          status: update?.status ?? null,
        },
      })
      if (!update?.message || Object.keys(update.message).length === 0) continue
      const existing = cache.messages.find((message) => message.jid === jid && message.id === id)
      const raw = {
        key,
        messageTimestamp: update.messageTimestamp || existing?.timestamp || nowSeconds(),
        message: update.message,
        pushName: existing?.pushName || null,
      }
      const ingested = await ingestMessages([raw], 'update')
      changed = changed || ingested
    } catch (error) {
      mirrorStore?.recordEvent({ event: 'messages.update_failed', jid, messageId: id, detail: { error: error.message } })
      logger.error({ err: error, jid, messageId: id }, 'Could not apply WhatsApp message update; bridge remains connected')
    }
  }
  return changed
}

async function handleHistorySet({ messages, chats, contacts }) {
  for (const chat of chats || []) {
    if (chat.id) {
      const previousChat = cache.chats[chat.id] || {}
      const remoteLastTimestamp = Number(chat.conversationTimestamp || 0)
      cache.chats[chat.id] = {
        ...previousChat,
        jid: chat.id,
        name: chat.name || previousChat.name || null,
        lastTimestamp: Math.max(Number(previousChat.lastTimestamp || 0), remoteLastTimestamp),
        remoteLastTimestamp: Math.max(Number(previousChat.remoteLastTimestamp || 0), remoteLastTimestamp),
      }
    }
  }
  for (const contact of contacts || []) {
    if (contact.id) cache.contacts[contact.id] = {
      id: contact.id,
      name: contact.name || contact.notify || contact.verifiedName || null,
    }
  }
  cache.sync.lastHistorySyncAt = nowSeconds()
  await ingestMessages(messages || [], 'history')
  cache.sync.lastPersistedAt = nowSeconds()
  await saveCache()
}

async function handleConnectionUpdate({ connection: next, lastDisconnect, qr }) {
  if (qr) {
    console.log('\nScan this QR in WhatsApp: Settings → Linked devices → Link a device\n')
    qrcodeTerminal.generate(qr, { small: true })
    await QRCode.toFile(qrPath, qr, { width: 720, margin: 2, errorCorrectionLevel: 'M' })
    await fs.chmod(qrPath, 0o600)
    console.log(`QR image saved to ${qrPath}`)
  }
  if (next === 'open') {
    connection = 'open'
    lastError = null
    cache.sync.connectedAt = nowSeconds()
    cache.sync.lastConnectedAt = cache.sync.connectedAt
    cache.sync.ingestionHealthy = true
    await saveCache()
    await fs.rm(qrPath, { force: true })
    console.log('WhatsApp bridge connected (read-only).')
  }
  if (next === 'close') {
    const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
    connection = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected'
    lastError = statusCode ? `WhatsApp disconnect (${statusCode})` : 'WhatsApp disconnected'
    cache.sync.lastDisconnectedAt = nowSeconds()
    cache.sync.ingestionHealthy = false
    await saveCache()
    if (statusCode !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(() => connect().catch(console.error), 3000)
    else console.error('WhatsApp logged this bridge out. Delete auth/ and restart to link it again.')
  }
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
    getMessage: getMessageFromMirror,
    msgRetryCounterCache,
  })

  socket.ev.process(async (events) => {
    try {
      if (events['creds.update']) await saveCreds()
      if (events['connection.update']) await handleConnectionUpdate(events['connection.update'])
      if (events['messaging-history.set']) await handleHistorySet(events['messaging-history.set'])
      if (events['messages.upsert']) {
        const { messages } = events['messages.upsert']
        lastLiveMessageAt = nowSeconds()
        const changed = await ingestMessages(messages, 'live')
        cache.sync.ingestionHealthy = true
        cache.sync.lastIngestError = null
        cache.sync.lastPersistedAt = nowSeconds()
        if (changed) await saveCache()
      }
      if (events['messages.update']) {
        const changed = await applyMessageUpdates(events['messages.update'])
        if (changed) {
          cache.sync.lastPersistedAt = nowSeconds()
          await saveCache()
        }
      }
    } catch (error) {
      cache.sync.ingestionHealthy = false
      cache.sync.lastIngestError = error.message
      await saveCache().catch(() => {})
      logger.error({ err: error }, 'Could not process WhatsApp event batch; bridge remains connected')
    }
  })
}

async function main() {
  await ensurePrivateDir(authDir)
  await ensurePrivateDir(dataDir)
  await ensurePrivateDir(audioEnvelopeDir)
  await ensurePrivateDir(downloadedAudioDir)
  await ensurePrivateDir(imageEnvelopeDir)
  await ensurePrivateDir(downloadedImageDir)
  await ensurePrivateDir(documentEnvelopeDir)
  await ensurePrivateDir(downloadedDocumentDir)
  mirrorStore = new MirrorStore(mirrorPath, { retentionDays: RETENTION_DAYS })
  msgRetryCounterCache = mirrorStore.createRetryCache('message-retry', { ttlSeconds: 60 * 60 })
  cache = mirrorStore.load()
  if (mirrorStore.isEmpty()) cache = await readJson(cachePath, cache)
  ensureCacheShape()
  markBridgeProcessStarted()
  pruneMessages()
  await saveCache()
  await prunePrivateMedia()
  const token = await loadToken()

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const isAudioDownload = request.method === 'POST' && url.pathname === '/audio/download'
    const isImageDownload = request.method === 'POST' && url.pathname === '/images/download'
    const isDocumentDownload = request.method === 'POST' && url.pathname === '/documents/download'
    const isMessageReaction = request.method === 'POST' && url.pathname === '/messages/react'
    const isMessageSend = request.method === 'POST' && url.pathname === '/messages/send'
    const isDocumentSend = request.method === 'POST' && url.pathname === '/documents/send'
    const isGroupsList = request.method === 'GET' && url.pathname === '/groups'
    if (request.method !== 'GET' && !isAudioDownload && !isImageDownload && !isDocumentDownload && !isMessageReaction && !isMessageSend && !isDocumentSend) return json(response, 405, { error: 'method_not_allowed' })
    if (url.pathname === '/health') return json(response, 200, { connection, lastError, allowExplicitSend: true, cachedMessages: cache.messages.length, ...cache.sync, lastLiveMessageAt, retentionDays: RETENTION_DAYS, storage: 'sqlite' })
    if (!isAuthorized(request, token)) return json(response, 401, { error: 'unauthorized' })
    if (request.method === 'GET' && url.pathname === '/snapshot') return json(response, 200, cache)
    if (request.method === 'GET' && url.pathname === '/resolve') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(response, 400, { error: 'jid_required' })
      resolveCurrentJid(jid)
        .then((resolvedJid) => json(response, 200, { requestedJid: jid, jid: resolvedJid, remapped: resolvedJid !== jid }))
        .catch((error) => json(response, 422, { error: 'jid_resolution_failed', message: error.message }))
      return
    }
    if (isGroupsList) {
      if (!socket?.groupFetchAllParticipating) return json(response, 503, { error: 'whatsapp_not_connected' })
      socket.groupFetchAllParticipating()
        .then((groups) => json(response, 200, {
          groups: Object.values(groups).map((group) => ({
            jid: group.id,
            subject: group.subject || null,
            desc: group.desc || null,
            participantCount: group.participants?.length || 0,
          })),
        }))
        .catch((error) => json(response, 422, { error: 'groups_fetch_failed', message: error.message }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/coverage') {
      const jid = url.searchParams.get('jid')
      if (!jid) return json(response, 400, { error: 'jid_required' })
      return json(response, 200, chatCoverage(jid))
    }
    if (isMessageSend) {
      requestBody(request).then(async ({ jid, text, replyToMessageId }) => {
        if (!jid || typeof text !== 'string' || !text.trim()) return json(response, 400, { error: 'invalid_message' })
        if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') return json(response, 400, { error: 'invalid_reply_target' })
        if (!socket?.sendMessage) return json(response, 503, { error: 'whatsapp_not_connected' })
        const quoted = replyToMessageId ? cache.messages.find((message) => message.jid === jid && message.id === replyToMessageId) : null
        if (replyToMessageId && !quoted) return json(response, 404, { error: 'reply_target_not_found' })
        const contextInfo = quoted ? {
          stanzaId: quoted.id,
          participant: quoted.participant || undefined,
          remoteJid: jid,
          quotedMessage: quoted.text ? { conversation: quoted.text } : undefined,
        } : undefined
        const result = await socket.sendMessage(jid, { text: text.trim(), contextInfo })
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
          mimetype: mimeTypeForFile(filePath),
          caption: caption?.trim() || undefined,
        })
        json(response, 200, { sent: true, id: result?.key?.id || null })
      }).catch((error) => json(response, 422, { error: 'document_send_failed', message: error.message }))
      return
    }
    if (isMessageReaction) {
      requestBody(request).then(async ({ jid, messageId, emoji }) => {
        if (!jid || !messageId || typeof emoji !== 'string' || !emoji.trim() || emoji.length > 16) return json(response, 400, { error: 'invalid_reaction' })
        const message = cache.messages.find((item) => item.jid === jid && item.id === messageId)
        if (!message) return json(response, 404, { error: 'message_not_found' })
        const key = { remoteJid: jid, id: message.id, fromMe: message.fromMe }
        if (message.participant) key.participant = message.participant
        const result = await socket.sendMessage(jid, { react: { text: emoji.trim(), key } })
        json(response, 200, { reacted: true, id: result?.key?.id || null })
      }).catch((error) => json(response, 422, { error: 'reaction_failed', message: error.message }))
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
    if (isImageDownload) {
      const jid = url.searchParams.get('jid')
      const messageId = url.searchParams.get('messageId')
      const message = cache.messages.find((item) => item.jid === jid && item.id === messageId && item.type === 'imageMessage')
      if (!message) return json(response, 404, { error: 'image_not_found' })
      downloadImage(message)
        .then((image) => json(response, 200, { image }))
        .catch((error) => json(response, 422, { error: 'image_download_failed', message: error.message }))
      return
    }
    if (isDocumentDownload) {
      const jid = url.searchParams.get('jid')
      const messageId = url.searchParams.get('messageId')
      const message = cache.messages.find((item) => item.jid === jid && item.id === messageId && item.type === 'documentMessage')
      if (!message) return json(response, 404, { error: 'document_not_found' })
      downloadDocument(message).then((document) => json(response, 200, { document })).catch((error) => json(response, 422, { error: 'document_download_failed', message: error.message }))
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
  await listenLocal(server)
  installGracefulShutdown(server)
  await connect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
