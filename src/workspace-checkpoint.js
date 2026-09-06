import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'

const execute = promisify(execFile)
export async function workspaceCheckpoint(directory) {
  if (!directory) return null
  const git = async (...args) => (await execute('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })).stdout
  const root = (await git('rev-parse', '--show-toplevel')).toString().trim()
  if (await fs.realpath(root) !== await fs.realpath(directory)) throw new Error('Consultation workspaces must be the root of an isolated Git checkout.')
  const head = (await git('rev-parse', 'HEAD')).toString().trim()
  const hash = crypto.createHash('sha256').update(head).update(await git('diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv')).update(await git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'))
  const files = (await git('ls-files', '--others', '--exclude-standard', '-z')).toString().split('\0').filter(Boolean).sort()
  if (files.length > 1000) throw new Error('Too many untracked files to checkpoint safely.')
  let bytes = 0
  for (const name of files) {
    const file = path.join(directory, name); const stat = await fs.lstat(file)
    bytes += stat.size
    if (bytes > 32 * 1024 * 1024) throw new Error('Untracked checkpoint exceeds 32 MB; use an isolated checkout.')
    hash.update(name).update(stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file))
  }
  return { head, digest: hash.digest('hex'), untrackedCount: files.length, at: new Date().toISOString() }
}
