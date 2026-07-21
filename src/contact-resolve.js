import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readIdentities, request } from './bridge-client.js'
import { macContactsForPhones, macContactsForQuery } from './mac-contacts.js'
import { paths } from './runtime-paths.js'
import { isDirectChat, normalizeSearchText as normalizeText } from './search-scope.js'

const { dataDir } = paths
const aliasesPath = path.join(dataDir, 'aliases.json')

export async function loadAliases() {
  try {
    return JSON.parse(await fs.readFile(aliasesPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

export async function saveAliases(aliases) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${aliasesPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(aliases, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, aliasesPath)
}

export function phoneToJid(value) {
  const digits = value.replace(/\D/g, '')
  if (!digits) throw new Error(`Invalid phone number: ${value}`)
  return `${digits}@s.whatsapp.net`
}

export function phoneFromJid(jid) {
  return jid?.replace(/@.+$/, '').replace(/\D/g, '') || ''
}

async function withCurrentJid(contact) {
  if (!contact?.jid || !contact.jid.endsWith('@s.whatsapp.net')) return contact
  const resolved = await request(`/resolve?jid=${encodeURIComponent(contact.jid)}`)
  return { ...contact, jid: resolved.jid || contact.jid, originalJid: contact.jid }
}

// Resolves an alias, phone, raw JID or WhatsApp display name to a single chat,
// always ending in the current LID for direct contacts. Ambiguity is an error,
// never a guess.
export async function resolveContact(target) {
  const aliases = await loadAliases()
  const key = target.toLocaleLowerCase()
  if (/^[^@\s]+@(s\.whatsapp\.net|lid|g\.us|broadcast)$/i.test(target) && !aliases[key]) return withCurrentJid({ phone: phoneFromJid(target), jid: target, alias: null, name: null })
  if (/^[+\d][\d\s()-]*$/.test(target) && !aliases[key]) return withCurrentJid({ phone: target.replace(/\D/g, ''), jid: phoneToJid(target), alias: null, name: null })
  const { chats } = await readIdentities()
  if (aliases[key]) {
    const alias = aliases[key]
    const aliasMatches = chats.filter((chat) => normalizeText(chat.name || '') === normalizeText(alias.name || ''))
    if (aliasMatches.length === 1) return withCurrentJid({ ...alias, jid: aliasMatches[0].jid, alias: key })
    return withCurrentJid({ ...alias, alias: key })
  }
  const normalizedTarget = normalizeText(target)
  const whatsappMatches = chats.filter((chat) => normalizeText(chat.name || '') === normalizedTarget)
  if (whatsappMatches.length === 1) return withCurrentJid({ phone: phoneFromJid(whatsappMatches[0].jid), jid: whatsappMatches[0].jid, alias: null, name: whatsappMatches[0].name || null })
  if (whatsappMatches.length > 1) throw new Error(`More than one WhatsApp chat matches “${target}”. Use a phone number or save an alias.`)
  const exactMatches = macContactsForQuery(target)
    .filter((match) => normalizeText(match.name) === normalizeText(target))
  const phones = [...new Set(exactMatches.flatMap((match) => match.phones.map((phone) => phone.replace(/\D/g, '')).filter(Boolean)))]
  if (phones.length === 1) return withCurrentJid({ phone: phones[0], jid: phoneToJid(phones[0]), alias: null, name: exactMatches[0].name })
  if (phones.length > 1) throw new Error(`More than one contact matches “${target}”. Use a phone number or save an alias.`)
  throw new Error(`Unknown alias “${target}”. Run: wa alias add ${target} <phone> "Name"`)
}

export async function cacheMatches(query) {
  const normalized = normalizeText(query)
  const [{ chats }, textMatches] = await Promise.all([
    readIdentities(),
    normalized
      ? request(`/search?q=${encodeURIComponent(query)}&scope=direct&normalized=1&limit=50`).then(({ messages }) => messages)
      : Promise.resolve([]),
  ])
  const matchingTextByJid = new Map()
  for (const message of textMatches) {
    if (!matchingTextByJid.has(message.jid)) matchingTextByJid.set(message.jid, message.text)
  }
  return chats
    .filter((chat) => isDirectChat(chat.jid))
    .map((chat) => {
      const matchingName = chat.name && normalizeText(chat.name).includes(normalized) ? chat.name : null
      const matchingText = matchingTextByJid.get(chat.jid) || null
      const score = matchingName
        ? (normalizeText(matchingName) === normalized ? 900 : 700)
        : matchingText ? 200 : 0
      return { ...chat, lastTimestamp: chat.lastTimestamp || 0, matchingName, matchingText, score }
    })
    .filter((signal) => signal.score > 0)
    .sort((left, right) => right.score - left.score || right.lastTimestamp - left.lastTimestamp)
}

export async function recentChats(limit) {
  const identities = await readIdentities()
  const chats = identities.chats
    .filter((chat) => isDirectChat(chat.jid))
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
    .slice(0, limit)
  const contacts = macContactsForPhones(chats.map((chat) => phoneFromJid(chat.jid)))
  const contactByPhone = new Map(contacts.flatMap((contact) => contact.phones.map((phone) => [phone.replace(/\D/g, ''), contact.name])))
  return { chats, contactByPhone }
}
