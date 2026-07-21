import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { projectRoot } from './runtime-paths.js'

const contactsSearchScript = path.join(projectRoot, 'bin', 'contacts-search.swift')

// Optional macOS Contacts enrichment. It never copies the address book into
// the mirror; results are used transiently for identity resolution only.
function macContacts(args) {
  if (process.platform !== 'darwin' || process.env.WA_NO_MAC_CONTACTS === '1') return []
  const result = spawnSync('swift', [contactsSearchScript, ...args], { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) return []
  try { return JSON.parse(result.stdout) } catch { return [] }
}

export function macContactsForQuery(query) {
  return macContacts([query])
}

export function macContactsForPhones(phones) {
  const uniquePhones = [...new Set(phones.filter(Boolean))]
  return uniquePhones.length ? macContacts(['--phones', ...uniquePhones]) : []
}
