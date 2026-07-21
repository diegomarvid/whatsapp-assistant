#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { launchAgentLabel, launchAgentPlist } from '../src/launch-agent.js'
import { paths } from '../src/runtime-paths.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { dataDir, stateRoot, logsDir } = paths
const aliasesPath = path.join(dataDir, 'aliases.json')
const groupListsPath = path.join(dataDir, 'group-lists.json')
const tokenPath = path.join(dataDir, 'bridge-token')
const contactsSearchScript = path.join(root, 'bin', 'contacts-search.swift')
const baseUrl = 'http://127.0.0.1:3847'
const launchAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`)

function usage() {
  console.log(`Usage:
  wa status
  wa setup
  wa daemon install|status|restart|uninstall
  wa migrate-state <old-project-directory>
  wa aliases
  wa alias add <alias> <phone> [display name]
  wa find <name or alias>
  wa recent [limit]
  wa groups list <list>
  wa groups find <list> [term...]
  wa groups inspect <group-jid> [limit]
  wa groups add <list> <group-jid> [reason]
  wa latest <alias or phone>
  wa latest-incoming <alias or phone>
  wa coverage <alias or phone>
  wa history <alias or phone> [limit] [--ids]
  wa search <alias or phone> <text>
  wa search-all <text> [--since 7d] [--direct|--groups <list>]
  wa pending [--since 24h]
  wa pending --groups <list> [--since 24h]
  wa transcribe <alias or phone> latest
  wa audios <alias or phone> [limit]
  wa audio <alias or phone> <message-id>
  wa images <alias or phone> [limit]
  wa image <alias or phone> <message-id>
  wa image-text <alias or phone> <message-id>
  wa files <alias or phone> [limit]
  wa file <alias or phone> <message-id>
  wa react <alias or phone> <message-id|latest|latest-incoming> <emoji>
  wa send <alias or phone> <message>
  wa reply <alias or phone> <message-id|latest|latest-incoming> <message>
  wa send-file <alias or phone> <file> [caption]`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} failed`)
  return result.stdout?.trim() || ''
}

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

async function ensureRuntimeDirectories() {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await fs.chmod(stateRoot, 0o700)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fs.chmod(dataDir, 0o700)
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 })
  await fs.chmod(logsDir, 0o700)
}

function launchctlDomain() {
  return `gui/${process.getuid()}`
}

async function installDaemon() {
  if (process.platform !== 'darwin') throw new Error('The managed daemon is currently implemented for macOS. Run the bridge with `npm start` on other platforms.')
  await ensureRuntimeDirectories()
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true })
  const serverPath = path.join(root, 'src', 'server.js')
  const entryPath = process.env.WA_DAEMON_ENTRY || serverPath
  const entryArguments = process.env.WA_DAEMON_ENTRY ? ['__daemon'] : []
  const plist = launchAgentPlist({ nodePath: process.env.WA_DAEMON_NODE || process.execPath, serverPath, stateRoot, logsDir, entryPath, entryArguments })
  await fs.writeFile(launchAgentPath, plist, { mode: 0o600 })
  tryRun('launchctl', ['bootout', launchctlDomain(), launchAgentPath])
  run('launchctl', ['bootstrap', launchctlDomain(), launchAgentPath])
}

async function daemonStatus() {
  if (process.platform !== 'darwin') throw new Error('The managed daemon is currently implemented for macOS.')
  const result = tryRun('launchctl', ['print', `${launchctlDomain()}/${launchAgentLabel}`])
  if (result.status !== 0) {
    console.log(`Daemon not installed or not running. Run: wa daemon install`)
    return
  }
  console.log(result.stdout.trim())
}

async function restartDaemon() {
  if (process.platform !== 'darwin') throw new Error('The managed daemon is currently implemented for macOS.')
  if (!await fileExists(launchAgentPath)) return installDaemon()
  run('launchctl', ['kickstart', '-k', `${launchctlDomain()}/${launchAgentLabel}`])
}

async function uninstallDaemon() {
  if (process.platform !== 'darwin') throw new Error('The managed daemon is currently implemented for macOS.')
  tryRun('launchctl', ['bootout', launchctlDomain(), launchAgentPath])
  await fs.rm(launchAgentPath, { force: true })
}

async function fileExists(filename) {
  try { await fs.access(filename); return true } catch { return false }
}

async function waitForBridge(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return await request('/health') } catch { await new Promise((resolve) => setTimeout(resolve, 500)) }
  }
  return null
}

async function setup() {
  await installDaemon()
  const health = await waitForBridge()
  const qrPath = path.join(dataDir, 'link-qr.png')
  if (await fileExists(qrPath)) {
    console.log(`Scan the QR image at: ${qrPath}`)
    if (process.platform === 'darwin') tryRun('open', [qrPath])
  } else if (health?.connection === 'open') {
    console.log('WhatsApp Assistant is already linked and running.')
  } else {
    console.log(`Bridge started. Check ${path.join(logsDir, 'bridge.log')} for the pairing QR.`)
  }
}

async function migrateState(sourceRoot) {
  if (!sourceRoot) return usage()
  const source = path.resolve(sourceRoot)
  if (source === stateRoot) throw new Error('The source is already the active WhatsApp Assistant state directory.')
  const sourceAuth = path.join(source, 'auth')
  const sourceData = path.join(source, 'data')
  if (!await fileExists(sourceAuth) || !await fileExists(sourceData)) throw new Error(`No auth/ and data/ directories found in ${source}`)
  if (await fileExists(paths.authDir) || await fileExists(path.join(dataDir, 'mirror.sqlite'))) throw new Error(`The target state already exists at ${stateRoot}. Refusing to overwrite it.`)
  await ensureRuntimeDirectories()
  await fs.cp(sourceAuth, paths.authDir, { recursive: true, errorOnExist: true })
  for (const entry of await fs.readdir(sourceData)) {
    await fs.cp(path.join(sourceData, entry), path.join(dataDir, entry), { recursive: true, force: false, errorOnExist: true })
  }
  console.log(`Migrated private state to ${stateRoot}. Run: wa setup`)
}

async function loadAliases() {
  try {
    return JSON.parse(await fs.readFile(aliasesPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveAliases(aliases) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${aliasesPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(aliases, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, aliasesPath)
}

async function loadGroupLists() {
  try {
    return JSON.parse(await fs.readFile(groupListsPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { lists: {} }
    throw error
  }
}

async function saveGroupLists(groupLists) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${groupListsPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(groupLists, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, groupListsPath)
}

function phoneToJid(value) {
  const digits = value.replace(/\D/g, '')
  if (!digits) throw new Error(`Invalid phone number: ${value}`)
  return `${digits}@s.whatsapp.net`
}

function phoneFromJid(jid) {
  return jid?.replace(/@.+$/, '').replace(/\D/g, '') || ''
}

function isDirectChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast')
}

function normalizeText(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function macContacts(args) {
  const result = spawnSync('swift', [contactsSearchScript, ...args], { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) return []
  try { return JSON.parse(result.stdout) } catch { return [] }
}

function macContactsForQuery(query) {
  return macContacts([query])
}

function macContactsForPhones(phones) {
  const uniquePhones = [...new Set(phones.filter(Boolean))]
  return uniquePhones.length ? macContacts(['--phones', ...uniquePhones]) : []
}

async function withCurrentJid(contact) {
  if (!contact?.jid || !contact.jid.endsWith('@s.whatsapp.net')) return contact
  const resolved = await request(`/resolve?jid=${encodeURIComponent(contact.jid)}`)
  return { ...contact, jid: resolved.jid || contact.jid, originalJid: contact.jid }
}

async function resolve(target) {
  const aliases = await loadAliases()
  const key = target.toLocaleLowerCase()
  const cache = await readSnapshot()
  if (aliases[key]) {
    const alias = aliases[key]
    const aliasMatches = Object.values(cache.chats).filter((chat) => normalizeText(chat.name || cache.contacts[chat.jid]?.name || '') === normalizeText(alias.name || ''))
    if (aliasMatches.length === 1) return withCurrentJid({ ...alias, jid: aliasMatches[0].jid, alias: key })
    return withCurrentJid({ ...alias, alias: key })
  }
  if (/^[^@\s]+@(s\.whatsapp\.net|lid|g\.us|broadcast)$/i.test(target)) return withCurrentJid({ phone: phoneFromJid(target), jid: target, alias: null, name: null })
  if (/^[+\d][\d\s()-]*$/.test(target)) return withCurrentJid({ phone: target.replace(/\D/g, ''), jid: phoneToJid(target), alias: null, name: null })
  const normalizedTarget = normalizeText(target)
  const whatsappMatches = Object.values(cache.chats).filter((chat) => normalizeText(chat.name || cache.contacts[chat.jid]?.name || '') === normalizedTarget)
  if (whatsappMatches.length === 1) return withCurrentJid({ phone: phoneFromJid(whatsappMatches[0].jid), jid: whatsappMatches[0].jid, alias: null, name: whatsappMatches[0].name || cache.contacts[whatsappMatches[0].jid]?.name || null })
  if (whatsappMatches.length > 1) throw new Error(`More than one WhatsApp chat matches “${target}”. Use a phone number or save an alias.`)
  const exactMatches = macContactsForQuery(target)
    .filter((match) => normalizeText(match.name) === normalizeText(target))
  const phones = [...new Set(exactMatches.flatMap((match) => match.phones.map((phone) => phone.replace(/\D/g, '')).filter(Boolean)))]
  if (phones.length === 1) return withCurrentJid({ phone: phones[0], jid: phoneToJid(phones[0]), alias: null, name: exactMatches[0].name })
  if (phones.length > 1) throw new Error(`More than one contact matches “${target}”. Use a phone number or save an alias.`)
  throw new Error(`Unknown alias “${target}”. Run: wa alias add ${target} <phone> "Name"`)
}

async function request(endpoint) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  let response
  try {
    response = await fetch(`${baseUrl}${endpoint}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  } catch (error) {
    throw new Error(`WhatsApp observer unavailable: ${error.name === 'TimeoutError' ? 'request timed out' : error.message}`)
  }
  if (!response.ok) throw new Error(`Bridge request failed (${response.status}): ${await response.text()}`)
  return response.json()
}

async function readSnapshot() {
  return request('/snapshot')
}

async function requireFreshCoverage(contact) {
  const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
  if (!coverage.fresh) {
    throw new Error(`Latest selector is unavailable because this chat is not freshly synchronized (${coverage.reasons.join(', ')}). Run: wa coverage ${contact.alias || contact.name || contact.phone || contact.jid}`)
  }
  return coverage
}

async function whatsappGroups() {
  const { groups } = await request('/groups')
  return groups || []
}

async function downloadAudio(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/audio/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download audio: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function downloadImage(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/images/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download image: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function downloadDocument(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/documents/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Could not download document: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function reactToMessage(jid, messageId, emoji) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/messages/react`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jid, messageId, emoji }) })
  if (!response.ok) throw new Error(`Could not react: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function sendMessage(jid, text, replyToMessageId = null) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jid, text, replyToMessageId }),
  })
  if (!response.ok) throw new Error(`Could not send message: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function sendFile(jid, filePath, caption) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/documents/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jid, filePath, caption }),
  })
  if (!response.ok) throw new Error(`Could not send document: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function transcribe(audioPath) {
  const result = spawnSync('ct', ['transcribe', audioPath, 'es'], { encoding: 'utf8', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'ct transcribe failed')
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const transcriptPath = output.match(/(\/[^\n]+\.txt)/)?.[1]
  if (!transcriptPath) return output
  return fs.readFile(transcriptPath, 'utf8')
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' }).format(new Date(timestamp * 1000))
}

function printMessages(messages, { ids = false } = {}) {
  if (!messages.length) return console.log('No hay mensajes cacheados para este chat.')
  for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
    const author = message.fromMe ? 'Vos' : 'Contacto'
    const text = message.text || `[${message.type}]`
    const context = [message.quotedMessageId ? `↪ ${message.quotedMessageId}` : null, message.reactionToMessageId ? `reacción ${message.reactionText || ''} a ${message.reactionToMessageId}` : null].filter(Boolean).join(' · ')
    const source = message.source === 'live' ? '' : ' [cache histórico]'
    console.log(`${formatTime(message.timestamp)} — ${author}: ${text}${context ? ` (${context})` : ''}${ids ? ` [id: ${message.id}]` : ''}${source}`)
  }
}

async function cacheMatches(query) {
  const cache = await readSnapshot()
  const normalized = normalizeText(query)
  const signals = new Map()
  for (const chat of Object.values(cache.chats)) {
    if (!isDirectChat(chat.jid)) continue
    signals.set(chat.jid, {
      jid: chat.jid,
      names: new Set([chat.name, cache.contacts[chat.jid]?.name].filter(Boolean)),
      messageCount: 0,
      lastTimestamp: chat.lastTimestamp || 0,
      matchingText: null,
    })
  }
  for (const message of cache.messages) {
    if (!isDirectChat(message.jid)) continue
    const signal = signals.get(message.jid) || {
      jid: message.jid,
      names: new Set(),
      messageCount: 0,
      lastTimestamp: 0,
      matchingText: null,
    }
    if (message.pushName) signal.names.add(message.pushName)
    signal.messageCount += 1
    signal.lastTimestamp = Math.max(signal.lastTimestamp, message.timestamp || 0)
    if (!signal.matchingText && normalized && normalizeText(message.text || '').includes(normalized)) signal.matchingText = message.text
    signals.set(message.jid, signal)
  }
  return [...signals.values()]
    .map((signal) => {
      const names = [...signal.names]
      const name = names[0] || null
      const matchingName = names.find((candidate) => normalizeText(candidate).includes(normalized))
      const score = matchingName
        ? (normalizeText(matchingName) === normalized ? 900 : 700)
        : signal.matchingText ? 200 : 0
      return { ...signal, name, matchingName, score }
    })
    .filter((signal) => signal.score > 0)
    .sort((left, right) => right.score - left.score || right.lastTimestamp - left.lastTimestamp)
}

async function recentChats(limit) {
  const cache = await readSnapshot()
  const chats = Object.values(cache.chats)
    .filter((chat) => isDirectChat(chat.jid))
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
    .slice(0, limit)
  const contacts = macContactsForPhones(chats.map((chat) => phoneFromJid(chat.jid)))
  const contactByPhone = new Map(contacts.flatMap((contact) => contact.phones.map((phone) => [phone.replace(/\D/g, ''), contact.name])))
  return { cache, chats, contactByPhone }
}

async function groupCandidates(terms) {
  const normalizedTerms = terms.map(normalizeText).filter(Boolean)
  const [groups, cache] = await Promise.all([
    whatsappGroups(),
    readSnapshot(),
  ])
  const messagesByGroup = new Map()
  for (const message of cache.messages) {
    if (!message.jid?.endsWith('@g.us')) continue
    const text = message.text || ''
    const matchingTerm = normalizedTerms.find((term) => normalizeText(text).includes(term))
    if (!matchingTerm) continue
    const evidence = messagesByGroup.get(message.jid) || []
    evidence.push({ text, timestamp: message.timestamp, matchingTerm })
    messagesByGroup.set(message.jid, evidence)
  }
  return groups.map((group) => {
    const metadata = `${group.subject || ''} ${group.desc || ''}`
    const metadataMatches = normalizedTerms.filter((term) => normalizeText(metadata).includes(term))
    const evidence = messagesByGroup.get(group.jid) || []
    return {
      ...group,
      score: (metadataMatches.length * 100) + Math.min(evidence.length, 5) * 20,
      metadataMatches,
      evidence,
    }
  }).filter((group) => group.score > 0).sort((left, right) => right.score - left.score)
}

function printKnownGroup(group) {
  console.log(`conocido: ${group.subject || 'sin título'} (${group.jid})${group.reason ? ` — ${group.reason}` : ''}`)
}

function discoveryTerms(list, listName, extras = []) {
  const stopWords = new Set(['maspeak', 'con', 'para', 'las', 'los', 'del', 'una', 'uno', 'ops'])
  const inferred = (list.groups || []).flatMap((group) => (group.subject || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeText)
    .filter((term) => term.length >= 4 && !stopWords.has(term)))
  return [...new Set([...(list.terms || []), listName, ...extras, ...inferred])]
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') return usage()
  if (command === '__daemon') return import('../src/server.js')
  if (command === 'setup') return setup()
  if (command === 'migrate-state') return migrateState(args[0])
  if (command === 'daemon') {
    const action = args[0]
    if (action === 'install') { await installDaemon(); return console.log(`Daemon installed: ${launchAgentLabel}`) }
    if (action === 'status') return daemonStatus()
    if (action === 'restart') { await restartDaemon(); return console.log('Daemon restarted.') }
    if (action === 'uninstall') { await uninstallDaemon(); return console.log('Daemon removed. Private state was preserved.') }
    return usage()
  }
  if (command === 'status') return console.log(JSON.stringify(await request('/health'), null, 2))
  if (command === 'aliases') {
    const aliases = await loadAliases()
    const entries = Object.entries(aliases)
    if (!entries.length) return console.log('No hay aliases guardados.')
    for (const [alias, item] of entries) console.log(`${alias} → ${item.name || item.phone} (${item.phone})`)
    return
  }
  if (command === 'alias' && args[0] === 'add') {
    const [_, alias, phone, ...name] = args
    if (!alias || !phone) return usage()
    const aliases = await loadAliases()
    const key = alias.toLocaleLowerCase()
    aliases[key] = { phone: phone.replace(/\D/g, ''), jid: phoneToJid(phone), name: name.join(' ') || null }
    await saveAliases(aliases)
    return console.log(`Alias saved: ${key} → ${aliases[key].name || aliases[key].phone}`)
  }
  if (command === 'find') {
    const query = args.join(' ').trim()
    if (!query) return usage()
    const aliases = await loadAliases()
    const aliasHits = Object.entries(aliases).filter(([alias, item]) => `${alias} ${item.name || ''} ${item.phone}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const chatHits = await cacheMatches(query)
    const contactHits = macContactsForQuery(query)
    for (const [alias, item] of aliasHits) console.log(`alias: ${alias} → ${item.name || item.phone} (${item.phone})`)
    for (const chat of chatHits) {
      const identity = chat.matchingName || chat.name || 'sin nombre'
      const evidence = chat.matchingName
        ? `coincide con nombre de WhatsApp; ${chat.messageCount} mensajes recientes`
        : `menciona “${chat.matchingText.slice(0, 90)}”; ${chat.messageCount} mensajes recientes`
      console.log(`WhatsApp: ${identity} (${chat.jid}) — ${evidence}`)
    }
    for (const contact of contactHits) console.log(`contacto: ${contact.name} (${contact.phones.join(', ')})`)
    if (!aliasHits.length && !chatHits.length && !contactHits.length) console.log('Sin coincidencias.')
    return
  }
  if (command === 'recent') {
    const limit = Math.min(Math.max(Number.parseInt(args[0] || '20', 10) || 20, 1), 50)
    const { cache, chats, contactByPhone } = await recentChats(limit)
    const aliases = await loadAliases()
    const aliasByPhone = new Map(Object.values(aliases).map((item) => [item.phone, item.name || item.phone]))
    for (const chat of chats) {
      const phone = phoneFromJid(chat.jid)
      const name = aliasByPhone.get(phone) || cache.contacts[chat.jid]?.name || chat.name || contactByPhone.get(phone) || 'sin nombre'
      console.log(`${formatTime(chat.lastTimestamp)} — ${name} (${phone || chat.jid})`)
    }
    return
  }
  if (command === 'groups') {
    const action = args.shift()
    if (!action || !['list', 'find', 'inspect', 'add'].includes(action)) return usage()
    if (action === 'inspect') {
      const jid = args.shift()
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '12', 10) || 12, 1), 50)
      if (!jid) return usage()
      const [groups, cache] = await Promise.all([whatsappGroups(), readSnapshot()])
      const group = groups.find((item) => item.jid === jid)
      if (!group) throw new Error(`Unknown WhatsApp group: ${jid}`)
      console.log(`Grupo: ${group.subject || 'sin título'} (${group.jid})`)
      if (group.desc) console.log(`Descripción: ${group.desc}`)
      const messages = cache.messages
        .filter((message) => message.jid === jid && message.text?.trim())
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, limit)
      for (const message of messages) console.log(`${formatTime(message.timestamp)} — ${message.fromMe ? 'Vos' : message.pushName || 'Contacto'}: ${message.text.slice(0, 500)}`)
      return
    }
    const listName = args.shift()?.toLocaleLowerCase()
    if (!listName) return usage()
    const groupLists = await loadGroupLists()
    const list = groupLists.lists[listName] || { terms: [listName], groups: [] }
    if (action === 'list') {
      if (!list.groups.length) return console.log(`No hay grupos guardados para ${listName}.`)
      list.groups.forEach(printKnownGroup)
      return
    }
    const groups = await whatsappGroups()
    if (action === 'add') {
      const jid = args.shift()
      const reason = args.join(' ').trim() || 'confirmado manualmente'
      const group = groups.find((item) => item.jid === jid)
      if (!group) throw new Error(`Unknown WhatsApp group: ${jid}`)
      const existing = list.groups.find((item) => item.jid === jid)
      if (existing) Object.assign(existing, { subject: group.subject, reason, lastSeenAt: new Date().toISOString() })
      else list.groups.push({ jid, subject: group.subject, reason, addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
      list.terms = discoveryTerms(list, listName)
      groupLists.lists[listName] = list
      await saveGroupLists(groupLists)
      return printKnownGroup(list.groups.find((item) => item.jid === jid))
    }
    const terms = discoveryTerms(list, listName, args)
    const candidates = await groupCandidates(terms)
    const knownIds = new Set(list.groups.map((group) => group.jid))
    if (list.groups.length) {
      console.log(`Grupos conocidos de ${listName}:`)
      list.groups.forEach(printKnownGroup)
    }
    const newCandidates = candidates.filter((group) => !knownIds.has(group.jid))
    if (newCandidates.length) {
      console.log(`Candidatos nuevos de ${listName}:`)
      for (const group of newCandidates) {
        const evidence = group.metadataMatches.length
          ? `coincide en título/descripción: ${group.metadataMatches.join(', ')}`
          : `${group.evidence.length} mensajes con ${group.evidence[0].matchingTerm}`
        console.log(`candidato: ${group.subject || 'sin título'} (${group.jid}) — ${evidence}; revisar: wa groups inspect ${group.jid}`)
      }
    }
    if (!list.groups.length && !newCandidates.length) console.log(`No encontré grupos candidatos para ${listName}.`)
    return
  }
  if (command === 'send') {
    const target = args.shift()
    const text = args.join(' ').trim()
    if (!target || !text) return usage()
    const contact = await resolve(target)
    const result = await sendMessage(contact.jid, text)
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'reply') {
    const target = args.shift()
    const selector = args.shift()
    const text = args.join(' ').trim()
    if (!target || !selector || !text) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    const quoted = selector === 'latest' ? messages[0] : selector === 'latest-incoming' ? messages.find((message) => !message.fromMe) : messages.find((message) => message.id === selector)
    if (!quoted) throw new Error(`No matching message found for reply selector: ${selector}`)
    if (selector === 'latest' || selector === 'latest-incoming') await requireFreshCoverage(contact)
    const result = await sendMessage(contact.jid, text, quoted.id)
    return console.log(`Reply sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'send-file') {
    const target = args.shift()
    const filePath = args.shift()
    const caption = args.join(' ').trim()
    if (!target || !filePath) return usage()
    const file = path.resolve(filePath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
    const contact = await resolve(target)
    const result = await sendFile(contact.jid, file, caption)
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'search-all') {
    const query = args.shift()?.trim()
    if (!query) return usage()
    let sinceSeconds = 0
    let scope = 'all'
    let groupList = null
    while (args.length) {
      const option = args.shift()
      if (option === '--since') {
        const value = args.shift() || ''
        const match = value.match(/^(\d+)(h|d)$/)
        if (!match) throw new Error('Use --since <n>h or <n>d')
        sinceSeconds = Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
      } else if (option === '--direct') scope = 'direct'
      else if (option === '--groups') { scope = 'groups'; groupList = args.shift() || null }
      else throw new Error(`Unknown option: ${option}`)
    }
    const cache = await readSnapshot()
    const allowedGroups = groupList ? new Set((await loadGroupLists()).lists[groupList]?.groups?.map((group) => group.jid) || []) : null
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds
    const matches = cache.messages.filter((message) => message.timestamp >= cutoff && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (scope === 'all' || (scope === 'direct' && isDirectChat(message.jid)) || (scope === 'groups' && message.jid.endsWith('@g.us') && (!allowedGroups || allowedGroups.has(message.jid))))).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100)
    return printMessages(matches)
  }
  if (command === 'pending') {
    let sinceSeconds = 86400
    let groupList = null
    while (args.length) {
      const option = args.shift()
      if (option === '--since') {
        const match = (args.shift() || '').match(/^(\d+)(h|d)$/)
        if (!match) throw new Error('Use --since <n>h or <n>d')
        sinceSeconds = Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
      } else if (option === '--groups') {
        groupList = args.shift()?.toLocaleLowerCase()
        if (!groupList) throw new Error('Use --groups <list>')
      } else throw new Error(`Unknown option: ${option}`)
    }
    const cache = await readSnapshot()
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds
    if (groupList) {
      const list = (await loadGroupLists()).lists[groupList]
      if (!list?.groups?.length) return console.log(`No hay grupos guardados para ${groupList}.`)
      const reviews = list.groups
        .map((group) => ({ group, messages: cache.messages.filter((message) => message.jid === group.jid).sort((a, b) => b.timestamp - a.timestamp) }))
        .filter(({ messages }) => messages[0] && !messages[0].fromMe && messages[0].timestamp >= cutoff)
      if (!reviews.length) return console.log(`No hay mensajes entrantes recientes como último intercambio en grupos de ${groupList}.`)
      for (const { group, messages } of reviews) {
        const message = messages[0]
        console.log(`${formatTime(message.timestamp)} — ${group.subject || group.jid}: ${message.text.slice(0, 500)} [id: ${message.id}]`)
      }
      return
    }
    const open = Object.values(cache.chats).filter((chat) => isDirectChat(chat.jid)).map((chat) => ({ chat, messages: cache.messages.filter((message) => message.jid === chat.jid).sort((a, b) => b.timestamp - a.timestamp) })).filter(({ messages }) => messages[0] && !messages[0].fromMe && messages[0].timestamp >= cutoff)
    if (!open.length) return console.log('No hay chats directos recientes pendientes de respuesta.')
    for (const { chat, messages } of open) { const message = messages[0]; console.log(`${formatTime(message.timestamp)} — ${cache.contacts[chat.jid]?.name || chat.name || phoneFromJid(chat.jid) || 'sin nombre'}: ${(message.text || `[${message.type}]`).slice(0, 500)}`) }
    return
  }
  if (command === 'latest' || command === 'latest-incoming' || command === 'coverage' || command === 'history' || command === 'search' || command === 'transcribe' || command === 'audios' || command === 'audio' || command === 'images' || command === 'image' || command === 'image-text' || command === 'files' || command === 'file' || command === 'react') {
    const target = args.shift()
    if (!target) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    if (command === 'coverage') {
      const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
      console.log(JSON.stringify({ chat: contact.name || target, ...coverage }, null, 2))
      return
    }
    if (command === 'latest' || command === 'latest-incoming') {
      await requireFreshCoverage(contact)
      const latest = command === 'latest-incoming' ? messages.find((message) => !message.fromMe) : messages[0]
      if (!latest) return console.log('No hay mensajes entrantes cacheados para este chat.')
      return printMessages([latest], { ids: args.includes('--ids') })
    }
    if (command === 'history') {
      await requireFreshCoverage(contact)
      const limit = Number.parseInt(args.find((argument) => argument !== '--ids') || '20', 10)
      return printMessages(messages.slice(0, limit), { ids: args.includes('--ids') })
    }
    if (command === 'transcribe' || command === 'audio') {
      const audioId = args[0] || 'latest'
      const audio = audioId === 'latest' ? messages.find((message) => message.type === 'audioMessage') : messages.find((message) => message.type === 'audioMessage' && message.id === audioId)
      if (!audio) return console.log('No hay un audio cacheado para este chat.')
      const { audio: downloaded } = await downloadAudio(contact.jid, audio.id)
      if (command === 'audio') return console.log(downloaded.path)
      console.log(await transcribe(downloaded.path))
      return
    }
    if (command === 'audios') {
      const audios = messages.filter((message) => message.type === 'audioMessage').slice(0, Number.parseInt(args[0] || '20', 10))
      if (!audios.length) return console.log('No hay audios cacheados para este chat.')
      for (const audio of audios) console.log(`${formatTime(audio.timestamp)} — ${audio.id} (${audio.audioRef ? 'disponible' : 'sin captura local'})`)
      return
    }
    if (command === 'images') {
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '20', 10) || 20, 1), 50)
      const images = messages.filter((message) => message.type === 'imageMessage').slice(0, limit)
      if (!images.length) return console.log('No hay imágenes cacheadas para este chat.')
      for (const image of images) {
        const availability = image.imageRef ? 'disponible' : 'sin captura local'
        const caption = image.text ? ` — ${image.text.slice(0, 500)}` : ''
        console.log(`${formatTime(image.timestamp)} — ${image.id} (${availability})${caption}`)
      }
      return
    }
    if (command === 'image') {
      const messageId = args.shift()
      if (!messageId) return usage()
      const { image } = await downloadImage(contact.jid, messageId)
      return console.log(image.path)
    }
    if (command === 'image-text') {
      const messageId = args.shift()
      if (!messageId) return usage()
      const { image } = await downloadImage(contact.jid, messageId)
      const result = spawnSync('swift', [path.join(root, 'bin', 'ocr-image.swift'), image.path], { encoding: 'utf8', timeout: 120000 })
      if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'OCR failed')
      return console.log(result.stdout.trim())
    }
    if (command === 'files' || command === 'file') {
      const files = messages.filter((message) => message.type === 'documentMessage')
      if (command === 'files') {
        const shown = files.slice(0, Number.parseInt(args[0] || '20', 10))
        if (!shown.length) return console.log('No hay archivos cacheados para este chat.')
        for (const file of shown) console.log(`${formatTime(file.timestamp)} — ${file.id} (${file.documentRef ? 'disponible' : 'sin captura local'}) — ${file.documentName || file.documentMimetype || 'archivo'}`)
        return
      }
      const messageId = args.shift()
      if (!messageId) return usage()
      const { document } = await downloadDocument(contact.jid, messageId)
      return console.log(document.path)
    }
    if (command === 'react') {
      const selector = args.shift(); const emoji = args.shift()
      if (!selector || !emoji) return usage()
      const message = selector === 'latest' ? messages[0] : selector === 'latest-incoming' ? messages.find((item) => !item.fromMe) : messages.find((item) => item.id === selector)
      if (!message) throw new Error(`No matching message found for reaction selector: ${selector}`)
      if (selector === 'latest' || selector === 'latest-incoming') await requireFreshCoverage(contact)
      await reactToMessage(contact.jid, message.id, emoji)
      return console.log('Reaction sent.')
    }
    const query = args.join(' ').trim().toLocaleLowerCase()
    if (!query) return usage()
    return printMessages(messages.filter((message) => message.text.toLocaleLowerCase().includes(query)))
  }
  usage()
}

main().catch((error) => {
  console.error(`wa: ${error.message}`)
  process.exitCode = 1
})
