import fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_RETENTION_DAYS = 7
export const MAX_RETENTION_DAYS = 3650
export const DEFAULT_MAX_MESSAGES = 10000

export function historyPolicyPath(dataDir) {
  return path.join(dataDir, 'history-policy.json')
}

export function historyPolicyForDays(value) {
  const requestedDays = Number.parseInt(value, 10)
  if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > MAX_RETENTION_DAYS) {
    throw new Error(`History retention must be between 1 and ${MAX_RETENTION_DAYS} days.`)
  }
  return {
    version: 1,
    retentionDays: requestedDays,
    // Baileys exposes only this boolean request to WhatsApp. It is a request,
    // not a guarantee that the provider will send the requested amount.
    syncFullHistory: requestedDays > DEFAULT_RETENTION_DAYS,
    // The seven-day default stays bounded. Extended retention honors its day
    // window instead of silently truncating it by an arbitrary message count.
    maxMessages: requestedDays > DEFAULT_RETENTION_DAYS ? null : DEFAULT_MAX_MESSAGES,
  }
}

export const DEFAULT_HISTORY_POLICY = Object.freeze(historyPolicyForDays(DEFAULT_RETENTION_DAYS))

export function normalizeHistoryPolicy(value) {
  const requested = value?.retentionDays ?? DEFAULT_RETENTION_DAYS
  try {
    return historyPolicyForDays(requested)
  } catch {
    return { ...DEFAULT_HISTORY_POLICY }
  }
}

export async function loadHistoryPolicy(dataDir) {
  try {
    return normalizeHistoryPolicy(JSON.parse(await fs.readFile(historyPolicyPath(dataDir), 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_HISTORY_POLICY }
    throw error
  }
}

export async function saveHistoryPolicy(dataDir, policy) {
  const normalized = normalizeHistoryPolicy(policy)
  const target = historyPolicyPath(dataDir)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, target)
  return normalized
}
