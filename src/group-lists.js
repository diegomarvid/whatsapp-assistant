import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { request, whatsappGroups } from './bridge-client.js'
import { paths } from './runtime-paths.js'
import { normalizeSearchText as normalizeText } from './search-scope.js'

const { dataDir } = paths
const groupListsPath = path.join(dataDir, 'group-lists.json')

export async function loadGroupLists() {
  try {
    return JSON.parse(await fs.readFile(groupListsPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { lists: {} }
    throw error
  }
}

export async function saveGroupLists(groupLists) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${groupListsPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(groupLists, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, groupListsPath)
}

export function printKnownGroup(group) {
  console.log(`conocido: ${group.subject || 'sin título'} (${group.jid})${group.reason ? ` — ${group.reason}` : ''}`)
}

export function discoveryTerms(list, listName, extras = []) {
  const stopWords = new Set(['maspeak', 'con', 'para', 'las', 'los', 'del', 'una', 'uno', 'ops'])
  const inferred = (list.groups || []).flatMap((group) => (group.subject || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeText)
    .filter((term) => term.length >= 4 && !stopWords.has(term)))
  return [...new Set([...(list.terms || []), listName, ...extras, ...inferred])]
}

export async function groupCandidates(terms) {
  const normalizedTerms = [...new Set(terms.map(normalizeText).filter(Boolean))]
  const [groups, ...termMatches] = await Promise.all([
    whatsappGroups(),
    ...normalizedTerms.map((term) => request(`/search?q=${encodeURIComponent(term)}&scope=groups&normalized=1&limit=100`)
      .then(({ messages }) => messages.map((message) => ({ ...message, matchingTerm: term })))
      .catch(() => [])),
  ])
  const messagesByGroup = new Map()
  for (const message of termMatches.flat()) {
    const evidence = messagesByGroup.get(message.jid) || []
    evidence.push({ text: message.text || '', timestamp: message.timestamp, matchingTerm: message.matchingTerm })
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
