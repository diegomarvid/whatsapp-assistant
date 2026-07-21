import fs from 'node:fs/promises'
import path from 'node:path'
import { bridgeBaseUrl } from './bridge-endpoint.js'
import { paths } from './runtime-paths.js'

// HTTP client for the loopback bridge API. This is the only place the CLI
// talks to the observer; every function returns parsed JSON or throws a
// human-readable error.
const tokenPath = path.join(paths.dataDir, 'bridge-token')
const baseUrl = bridgeBaseUrl()

async function bearerToken() {
  return (await fs.readFile(tokenPath, 'utf8')).trim()
}

export async function request(endpoint, { timeoutMs = 5000 } = {}) {
  const token = await bearerToken()
  let response
  try {
    response = await fetch(`${baseUrl}${endpoint}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`WhatsApp observer unavailable: ${error.name === 'TimeoutError' ? 'request timed out' : error.message}`)
  }
  if (!response.ok) throw new Error(`Bridge request failed (${response.status}): ${await response.text()}`)
  return response.json()
}

export async function bridgePost(pathname, body, failureMessage) {
  const token = await bearerToken()
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${failureMessage}: ${(await response.json()).message || response.status}`)
  return response.json()
}

export function readIdentities() {
  return request('/identities')
}

export async function requireFreshCoverage(contact) {
  const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
  if (!coverage.fresh) {
    throw new Error(`Latest selector is unavailable because this chat is not freshly synchronized (${coverage.reasons.join(', ')}). Run: wa coverage ${contact.alias || contact.name || contact.phone || contact.jid}`)
  }
  return coverage
}

export async function whatsappGroups() {
  const { groups } = await request('/groups')
  return groups || []
}

export async function whatsappGroup(jid) {
  const { group } = await request(`/groups?jid=${encodeURIComponent(jid)}`)
  return group
}

async function downloadEnvelope(pathname, jid, messageId, failureMessage) {
  const token = await bearerToken()
  const response = await fetch(`${baseUrl}${pathname}?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`${failureMessage}: ${(await response.json()).message || response.status}`)
  return response.json()
}

export function downloadAudio(jid, messageId) {
  return downloadEnvelope('/audio/download', jid, messageId, 'Could not download audio')
}

export function downloadImage(jid, messageId) {
  return downloadEnvelope('/images/download', jid, messageId, 'Could not download image')
}

export function downloadDocument(jid, messageId) {
  return downloadEnvelope('/documents/download', jid, messageId, 'Could not download document')
}

export function downloadVideo(jid, messageId) {
  return downloadEnvelope('/videos/download', jid, messageId, 'Could not download video')
}

export function downloadSticker(jid, messageId) {
  return downloadEnvelope('/stickers/download', jid, messageId, 'Could not download sticker')
}

export function reactToMessage(jid, messageId, emoji) {
  return bridgePost('/messages/react', { jid, messageId, emoji }, 'Could not react')
}

export function sendMessage(jid, text, replyToMessageId = null, mentions = []) {
  return bridgePost('/messages/send', { jid, text, replyToMessageId, mentions }, 'Could not send message')
}

export function sendMedia(jid, kind, filePath, caption = '', mentions = [], voice = false, replyToMessageId = null) {
  return bridgePost('/media/send', { jid, kind, filePath, caption, mentions, voice, replyToMessageId }, `Could not send ${kind}`)
}

export function sendFile(jid, filePath, caption, replyToMessageId = null) {
  return bridgePost('/documents/send', { jid, filePath, caption, replyToMessageId }, 'Could not send document')
}

export function editMessage(jid, messageId, text) {
  return bridgePost('/messages/edit', { jid, messageId, text }, 'Could not edit message')
}

export function revokeMessage(jid, messageId) {
  return bridgePost('/messages/revoke', { jid, messageId }, 'Could not unsend message')
}

export function markMessageRead(jid, messageId) {
  return bridgePost('/messages/read', { jid, messageId }, 'Could not mark as read')
}

// Resolves an explicit id or a latest/latest-incoming selector to a concrete
// message; selectors additionally require fresh coverage so an action never
// silently targets a stale "latest".
export async function resolveMessageSelector(contact, selector, { ownOnly = false, incomingOnly = false } = {}) {
  const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
  const target = selector === 'latest'
    ? messages.find((message) => !ownOnly || message.fromMe)
    : selector === 'latest-incoming'
      ? messages.find((message) => !message.fromMe)
      : messages.find((message) => message.id === selector)
  if (!target) throw new Error(`No matching message found for selector: ${selector}`)
  if (selector === 'latest' || selector === 'latest-incoming') await requireFreshCoverage(contact)
  if (ownOnly && !target.fromMe) throw new Error('This action only applies to a message sent by this account.')
  if (incomingOnly && target.fromMe) throw new Error('This action only applies to an incoming message.')
  return target
}
