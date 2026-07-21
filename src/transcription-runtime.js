import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_MLX_MODEL = 'mlx-community/whisper-large-v3-turbo'
export const DEFAULT_FASTER_MODEL = 'Systran/faster-whisper-small'

function absoluteEnvPath(env, name, fallback) {
  const value = env[name]?.trim()
  return value && path.isAbsolute(value) ? value : fallback
}

export function transcriptionBackend({ platform = process.platform, arch = process.arch } = {}) {
  return platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'faster-whisper'
}

export function defaultModelFor(backend) {
  return backend === 'mlx' ? DEFAULT_MLX_MODEL : DEFAULT_FASTER_MODEL
}

export function huggingFaceHubPath({ env = process.env, home } = {}) {
  const cacheHome = absoluteEnvPath(env, 'XDG_CACHE_HOME', path.join(home, '.cache'))
  const hfHome = absoluteEnvPath(env, 'HF_HOME', path.join(cacheHome, 'huggingface'))
  return absoluteEnvPath(env, 'HF_HUB_CACHE', path.join(hfHome, 'hub'))
}

function cacheDirectoryForModel(model) {
  return `models--${model.replaceAll('/', '--')}`
}

function snapshotPath(cacheDirectory) {
  const refsMain = path.join(cacheDirectory, 'refs', 'main')
  try {
    const revision = fs.readFileSync(refsMain, 'utf8').trim()
    const snapshot = path.join(cacheDirectory, 'snapshots', revision)
    if (fs.statSync(snapshot).isDirectory()) return snapshot
  } catch {}
  try {
    const snapshots = fs.readdirSync(path.join(cacheDirectory, 'snapshots')).sort().reverse()
    for (const name of snapshots) {
      const snapshot = path.join(cacheDirectory, 'snapshots', name)
      if (fs.statSync(snapshot).isDirectory()) return snapshot
    }
  } catch {}
  return null
}

export function cachedModelSnapshot(model, { env = process.env, home } = {}) {
  if (path.isAbsolute(model)) {
    try { return fs.statSync(model).isDirectory() ? model : null } catch { return null }
  }
  return snapshotPath(path.join(huggingFaceHubPath({ env, home }), cacheDirectoryForModel(model)))
}

function modelFromCacheDirectory(name) {
  return name.startsWith('models--') ? name.slice('models--'.length).replaceAll('--', '/') : null
}

function modelPreference(model) {
  const lower = model.toLowerCase()
  if (lower.includes('large-v3-turbo')) return 0
  if (lower.includes('large')) return 1
  if (lower.includes('medium')) return 2
  if (lower.includes('small')) return 3
  if (lower.includes('base')) return 4
  if (lower.includes('tiny')) return 5
  return 6
}

export function cachedCompatibleModels(backend, { env = process.env, home } = {}) {
  const root = huggingFaceHubPath({ env, home })
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => modelFromCacheDirectory(entry.name))
      .filter(Boolean)
      .filter((model) => model.toLowerCase().includes('whisper'))
      .filter((model) => backend === 'mlx' ? model.startsWith('mlx-community/') : model.startsWith('Systran/faster-whisper'))
      .map((model) => ({ model, path: cachedModelSnapshot(model, { env, home }) }))
      .filter((item) => item.path)
      .sort((left, right) => modelPreference(left.model) - modelPreference(right.model) || left.model.localeCompare(right.model))
  } catch {
    return []
  }
}

export function selectLocalModel({ backend, configuredModel = null, env = process.env, home }) {
  if (configuredModel) {
    const configuredPath = cachedModelSnapshot(configuredModel, { env, home })
    return configuredPath ? { model: configuredModel, path: configuredPath, source: 'configured' } : null
  }
  const defaultModel = defaultModelFor(backend)
  const defaultPath = cachedModelSnapshot(defaultModel, { env, home })
  if (defaultPath) return { model: defaultModel, path: defaultPath, source: 'default-cache' }
  const candidates = cachedCompatibleModels(backend, { env, home })
  return candidates.length ? { ...candidates[0], source: 'compatible-cache' } : null
}
