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
const baseUrl = 'http://127.0.0.1:3847'

function usage() {
  console.log(`Usage:
  wa status
  wa aliases
  wa alias add <alias> <phone> [display name]
  wa find <name or alias>
  wa latest <alias or phone>
  wa history <alias or phone> [limit]
  wa search <alias or phone> <text>
  wa transcribe <alias or phone> latest`)
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

async function resolve(target) {
  const aliases = await loadAliases()
  const key = target.toLocaleLowerCase()
  if (aliases[key]) return { ...aliases[key], alias: key }
  if (/^[+\d][\d\s()-]*$/.test(target)) return { phone: target.replace(/\D/g, ''), jid: phoneToJid(target), alias: null, name: null }
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

async function transcribe(audioPath) {
  const result = spawnSync('ct', ['transcribe', audioPath, 'es'], { encoding: 'utf8', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'ct transcribe failed')
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const transcriptPath = output.match(/(\/[^\n]+\.txt)\s*$/)?.[1]
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
  const normalized = query.toLocaleLowerCase()
  return Object.values(cache.chats)
    .map((chat) => ({ ...chat, name: cache.contacts[chat.jid]?.name || chat.name || null }))
    .filter((chat) => `${chat.name || ''} ${chat.jid}`.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
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
    for (const [alias, item] of aliasHits) console.log(`alias: ${alias} → ${item.name || item.phone} (${item.phone})`)
    for (const chat of chatHits) console.log(`chat: ${chat.name || 'sin nombre'} (${chat.jid})`)
    if (!aliasHits.length && !chatHits.length) console.log('Sin coincidencias.')
    return
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
