#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
const aliasesPath = path.join(dataDir, 'aliases.json')
const cachePath = path.join(dataDir, 'messages.json')
const tokenPath = path.join(dataDir, 'bridge-token')
const contactsSearchScript = path.join(root, 'bin', 'contacts-search.swift')
const baseUrl = 'http://127.0.0.1:3847'

function usage() {
  console.log(`Usage:
  wa status
  wa aliases
  wa alias add <alias> <phone> [display name]
  wa find <name or alias>
  wa recent [limit]
  wa latest <alias or phone>
  wa history <alias or phone> [limit]
  wa search <alias or phone> <text>
  wa transcribe <alias or phone> latest
  wa send <alias or phone> <message>
  wa send-file <alias or phone> <file> [caption]`)
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

async function resolve(target) {
  const aliases = await loadAliases()
  const key = target.toLocaleLowerCase()
  if (aliases[key]) return { ...aliases[key], alias: key }
  if (/^[+\d][\d\s()-]*$/.test(target)) return { phone: target.replace(/\D/g, ''), jid: phoneToJid(target), alias: null, name: null }
  const exactMatches = macContactsForQuery(target)
    .filter((match) => normalizeText(match.name) === normalizeText(target))
  const phones = [...new Set(exactMatches.flatMap((match) => match.phones.map((phone) => phone.replace(/\D/g, '')).filter(Boolean)))]
  if (phones.length === 1) return { phone: phones[0], jid: phoneToJid(phones[0]), alias: null, name: exactMatches[0].name }
  if (phones.length > 1) throw new Error(`More than one contact matches “${target}”. Use a phone number or save an alias.`)
  throw new Error(`Unknown alias “${target}”. Run: wa alias add ${target} <phone> "Name"`)
}

async function request(endpoint) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}${endpoint}`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Bridge request failed (${response.status}): ${await response.text()}`)
  return response.json()
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

async function sendMessage(jid, text) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jid, text }),
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

function printMessages(messages) {
  if (!messages.length) return console.log('No hay mensajes cacheados para este chat.')
  for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
    const author = message.fromMe ? 'Vos' : 'Contacto'
    const text = message.text || `[${message.type}]`
    console.log(`${formatTime(message.timestamp)} — ${author}: ${text}`)
  }
}

async function cacheMatches(query) {
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'))
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
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'))
  const chats = Object.values(cache.chats)
    .filter((chat) => isDirectChat(chat.jid))
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
    .slice(0, limit)
  const contacts = macContactsForPhones(chats.map((chat) => phoneFromJid(chat.jid)))
  const contactByPhone = new Map(contacts.flatMap((contact) => contact.phones.map((phone) => [phone.replace(/\D/g, ''), contact.name])))
  return { cache, chats, contactByPhone }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') return usage()
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
  if (command === 'send') {
    const target = args.shift()
    const text = args.join(' ').trim()
    if (!target || !text) return usage()
    const contact = await resolve(target)
    const result = await sendMessage(contact.jid, text)
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}.`)
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
  if (command === 'latest' || command === 'history' || command === 'search' || command === 'transcribe') {
    const target = args.shift()
    if (!target) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    if (command === 'latest') return printMessages(messages.slice(0, 1))
    if (command === 'history') return printMessages(messages.slice(0, Number.parseInt(args[0] || '20', 10)))
    if (command === 'transcribe') {
      if (args[0] !== 'latest') return usage()
      const audio = messages.find((message) => message.type === 'audioMessage')
      if (!audio) return console.log('No hay un audio cacheado para este chat.')
      const { audio: downloaded } = await downloadAudio(contact.jid, audio.id)
      console.log(await transcribe(downloaded.path))
      return
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
