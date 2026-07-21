import { spawnSync } from 'node:child_process'

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} failed`)
  return result.stdout?.trim() || ''
}

export function tryRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}
