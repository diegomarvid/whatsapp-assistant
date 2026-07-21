import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function isPackagedInstall(root) {
  return root.split(path.sep).includes('node_modules')
}

export function runtimePaths({ root = projectRoot, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const configuredStateDir = env.WA_STATE_DIR?.trim()
  const stateRoot = configuredStateDir
    ? path.resolve(configuredStateDir)
    : isPackagedInstall(root)
      ? platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'WhatsApp Assistant')
        : path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'whatsapp-assistant')
      : root

  return {
    projectRoot: root,
    stateRoot,
    authDir: path.join(stateRoot, 'auth'),
    dataDir: path.join(stateRoot, 'data'),
    logsDir: path.join(stateRoot, 'logs'),
  }
}

export const paths = runtimePaths()
