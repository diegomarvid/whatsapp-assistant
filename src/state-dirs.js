import fs from 'node:fs/promises'
import { paths } from './runtime-paths.js'

const { dataDir, stateRoot, logsDir } = paths

export async function ensureRuntimeDirectories() {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await fs.chmod(stateRoot, 0o700)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fs.chmod(dataDir, 0o700)
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 })
  await fs.chmod(logsDir, 0o700)
}

export async function fileExists(filename) {
  try { await fs.access(filename); return true } catch { return false }
}
