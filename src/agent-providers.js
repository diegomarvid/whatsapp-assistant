import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tryRun } from './exec.js'

// This is deliberately a small, versioned convenience catalog rather than a
// hard allow-list. Providers rename models often; profiles may use any model
// identifier and `wa agents validate` proves whether the selected one works.
export const PROVIDER_CATALOG_VERSION = 1
export const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', binary: 'claude', helpArgs: ['--help'],
    modelAliases: ['opus', 'sonnet', 'haiku'],
    knownEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsEffort: true, supportsReasoningEffort: false,
    envPassthrough: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
  }),
  codex: Object.freeze({
    id: 'codex', label: 'Codex CLI', binary: 'codex', helpArgs: ['exec', '--help'],
    // These are discoverable convenience choices, never a restrictive model
    // allow-list. Keep the full GPT-5.6 family and its current effort dialect
    // visible so a profile can express, for example, Luna at max reasoning.
    modelAliases: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5', 'gpt-5-mini'], supportsEffort: false, supportsReasoningEffort: true,
    knownEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    envPassthrough: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  }),
})

const PROFILE_VERSION = 1
const DETECTION_VERSION = 1
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]{1,160}$/
const MAX_PROMPT_BYTES = 256 * 1024
const BASE_PROVIDER_ENVIRONMENT = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function structured(value) {
  return structuredClone(value)
}

function validProvider(provider) {
  const definition = PROVIDERS[provider]
  if (!definition) throw new Error(`Unknown AI provider: ${provider}. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`)
  return definition
}

function validName(name) {
  const normalized = String(name || '').trim().toLocaleLowerCase()
  if (!NAME_PATTERN.test(normalized)) throw new Error('Profile names use lowercase letters, numbers and hyphens, and must start with a letter.')
  return normalized
}

function validIdentifier(value, label) {
  const normalized = String(value || '').trim()
  if (normalized.startsWith('-')) throw new Error(`${label} cannot start with "-" because a provider would parse it as a flag.`)
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(`${label} must be a simple provider identifier (letters, numbers, ., _, :, / or -).`)
  return normalized
}

function validTimeout(value) {
  if (value === null || value === undefined) return 60000
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 300000) throw new Error('timeoutMs must be an integer between 1000 and 300000.')
  return parsed
}

async function inspectWorkspaceDirectory(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Automation workspaces must use an absolute path.')
  const resolved = await fs.realpath(filename)
  const stat = await fs.stat(resolved)
  if (!stat.isDirectory()) throw new Error(`Automation workspace is not a directory: ${resolved}`)
  const currentUserId = typeof process.getuid === 'function' ? process.getuid() : null
  if (currentUserId !== null && stat.uid !== currentUserId) throw new Error(`Automation workspaces must be owned by the current user: ${resolved}`)
  return { path: resolved }
}

function normalizeProfile(input, { previous = null, now = new Date().toISOString() } = {}) {
  const name = validName(input.name ?? previous?.name)
  const provider = String(input.provider ?? previous?.provider ?? '').trim().toLocaleLowerCase()
  const definition = validProvider(provider)
  const model = validIdentifier(input.model ?? previous?.model, 'model')
  const effortValue = input.effort === undefined ? previous?.effort : input.effort
  const effort = effortValue === null || effortValue === undefined || effortValue === '' ? null : validIdentifier(effortValue, 'effort')
  const reasoningEffortValue = input.reasoningEffort === undefined ? previous?.reasoningEffort : input.reasoningEffort
  const reasoningEffort = reasoningEffortValue === null || reasoningEffortValue === undefined || reasoningEffortValue === '' ? null : validIdentifier(reasoningEffortValue, 'reasoning effort')
  if (effort && !definition.supportsEffort) throw new Error(`${definition.label} does not currently expose a per-invocation effort flag. Remove --effort rather than silently ignoring it.`)
  if (reasoningEffort && !definition.supportsReasoningEffort) throw new Error(`${definition.label} does not use Codex-style reasoning effort. Use --effort instead.`)
  if (effort && reasoningEffort) throw new Error('Choose either Claude --effort or Codex --reasoning-effort, not both.')
  const prompt = input.prompt ?? previous?.prompt ?? null
  if (!prompt?.path || !path.isAbsolute(prompt.path) || !/^[a-f0-9]{64}$/.test(prompt.sha256) || !Number.isInteger(prompt?.bytes) || prompt.bytes <= 0 || prompt.bytes > MAX_PROMPT_BYTES) throw new Error('A private absolute prompt file is required when creating a profile. Use --prompt-file <absolute path>.')
  const workspace = input.workspace === null ? null : input.workspace ?? previous?.workspace ?? null
  if (workspace !== null && (!workspace?.path || !path.isAbsolute(workspace.path))) throw new Error('Automation workspace must be an approved absolute directory. Use --workspace <absolute path>.')
  return {
    name, provider, model, effort, reasoningEffort, prompt: { path: prompt.path, sha256: prompt.sha256, bytes: prompt.bytes, modifiedAt: prompt.modifiedAt },
    workspace: workspace ? { path: workspace.path } : null,
    timeoutMs: validTimeout(input.timeoutMs ?? previous?.timeoutMs),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  }
}

export async function inspectPromptFile(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Prompt files must use an absolute path.')
  const resolved = await fs.realpath(filename)
  const handle = await fs.open(resolved, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`Prompt path is not a regular file: ${resolved}`)
    const currentUserId = typeof process.getuid === 'function' ? process.getuid() : null
    if (currentUserId !== null && stat.uid !== currentUserId) throw new Error(`Prompt files must be owned by the current user: ${resolved}`)
    if (stat.mode & 0o022) throw new Error(`Prompt files must not be group- or world-writable: ${resolved}`)
    if (stat.size <= 0) throw new Error('Prompt files cannot be empty.')
    if (stat.size > MAX_PROMPT_BYTES) throw new Error(`Prompt files are limited to ${MAX_PROMPT_BYTES} bytes.`)
    const contents = await handle.readFile()
    if (contents.length <= 0 || contents.length > MAX_PROMPT_BYTES) throw new Error(`Prompt files are limited to ${MAX_PROMPT_BYTES} bytes.`)
    return { path: resolved, sha256: crypto.createHash('sha256').update(contents).digest('hex'), bytes: contents.length, modifiedAt: stat.mtime.toISOString() }
  } finally {
    await handle.close()
  }
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  let handle = null
  try {
    handle = await fs.open(temporary, 'w', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, filename)
    let directory = null
    try {
      directory = await fs.open(path.dirname(filename), 'r')
      await directory.sync()
    } catch {} finally {
      await directory?.close().catch(() => {})
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

class PrivateJsonStore {
  constructor(filename, { now = () => Date.now(), lockTimeoutMs = 5000, staleLockMs = 30000, lockRetryMs = 25 } = {}) {
    this.filename = filename
    this.lockFilename = `${filename}.lock`
    this.now = now
    this.lockTimeoutMs = lockTimeoutMs
    this.staleLockMs = staleLockMs
    this.lockRetryMs = lockRetryMs
  }

  async withLock(work) {
    const deadline = this.now() + this.lockTimeoutMs
    let handle = null
    while (!handle) {
      try {
        await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
        handle = await fs.open(this.lockFilename, 'wx', 0o600)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          if (this.now() - (await fs.stat(this.lockFilename)).mtimeMs > this.staleLockMs) await fs.rm(this.lockFilename, { force: true })
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError
        }
        if (this.now() >= deadline) throw new Error('Timed out waiting for the private AI provider settings. Retry the command.')
        await wait(this.lockRetryMs)
      }
    }
    try {
      return await work()
    } finally {
      await handle.close().catch(() => {})
      await fs.rm(this.lockFilename, { force: true }).catch(() => {})
    }
  }
}

export class AgentProfiles extends PrivateJsonStore {
  async load() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return { version: PROFILE_VERSION, profiles: {} }
      throw new Error(`AI profiles could not be parsed. They were left unchanged; inspect ${this.filename} before trying again.`)
    }
    if (!parsed || parsed.version !== PROFILE_VERSION || !parsed.profiles || Array.isArray(parsed.profiles) || typeof parsed.profiles !== 'object') {
      throw new Error(`AI profiles file is malformed. It was left unchanged; inspect ${this.filename} before trying again.`)
    }
    for (const [name, profile] of Object.entries(parsed.profiles)) {
      try {
        parsed.profiles[name] = normalizeProfile({ ...profile, name }, { previous: profile, now: profile.updatedAt || new Date().toISOString() })
      } catch (error) {
        throw new Error(`AI profile "${name}" in ${this.filename} is invalid and was left unchanged: ${error.message}`)
      }
    }
    return parsed
  }

  async list() {
    const { profiles } = await this.load()
    return Object.values(profiles).sort((left, right) => left.name.localeCompare(right.name)).map(structured)
  }

  async get(name) {
    return structured((await this.load()).profiles[validName(name)] || null)
  }

  async set(input) {
    const prompt = input.promptFile ? await inspectPromptFile(input.promptFile) : undefined
    const workspace = input.workspace ? await inspectWorkspaceDirectory(input.workspace) : input.workspace === null ? null : undefined
    return this.withLock(async () => {
      const document = await this.load()
      const name = validName(input.name)
      const profile = normalizeProfile({ ...input, name, ...(prompt ? { prompt } : {}), ...(workspace !== undefined ? { workspace } : {}) }, { previous: document.profiles[name] || null })
      document.profiles[name] = profile
      await writeAtomic(this.filename, document)
      return structured(profile)
    })
  }

  async remove(name) {
    return this.withLock(async () => {
      const document = await this.load()
      const normalized = validName(name)
      const profile = document.profiles[normalized]
      if (!profile) throw new Error(`Unknown AI profile: ${normalized}`)
      delete document.profiles[normalized]
      await writeAtomic(this.filename, document)
      return structured(profile)
    })
  }
}

export class ProviderDetections extends PrivateJsonStore {
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'))
      if (!parsed || parsed.version !== DETECTION_VERSION || !parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) throw new Error('malformed')
      return parsed
    } catch (error) {
      if (error.code === 'ENOENT') return { version: DETECTION_VERSION, providers: {} }
      throw new Error(`AI provider detections could not be parsed. They were left unchanged; inspect ${this.filename} before trying again.`)
    }
  }

  async save(detection) {
    return this.saveAll([detection]).then(([saved]) => saved)
  }

  async saveAll(detections) {
    return this.withLock(async () => {
      const document = await this.load()
      for (const detection of detections) document.providers[detection.id] = detection
      await writeAtomic(this.filename, document)
      return detections.map(structured)
    })
  }
}

async function executableInPath(binary, env = process.env) {
  if (path.isAbsolute(binary)) {
    try { await fs.access(binary, fsConstants.X_OK); return fs.realpath(binary) } catch { return null }
  }
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, binary)
    try {
      await fs.access(candidate, fsConstants.X_OK)
      return await fs.realpath(candidate)
    } catch {}
  }
  return null
}

function outputOf(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}\n${result?.message || ''}`.trim().slice(0, 16000)
}

function versionLine(result) {
  return outputOf(result).split(/\r?\n/).find(Boolean) || null
}

function hasFlag(helpText, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|=|,|$)`, 'm').test(helpText)
}

export function safeProviderEnvironment(provider, env = process.env) {
  const definition = validProvider(provider)
  const names = [...BASE_PROVIDER_ENVIRONMENT, ...definition.envPassthrough]
  return Object.fromEntries(names.filter((name) => env[name] !== undefined && env[name] !== '').map((name) => [name, env[name]]))
}

export function classifyProviderError(detail) {
  const value = String(detail || '').toLocaleLowerCase()
  if (/model.*(not found|unknown|invalid)|unknown model|does not exist/.test(value)) return 'unknown_model'
  if (/enoent|command not found|no such file|is not on path/.test(value)) return 'binary_missing'
  if (/auth|login|sign in|api key|credential|unauthorized|forbidden/.test(value)) return 'auth_required'
  if (/unknown option|unknown flag|unsupported.*flag|unrecognized option/.test(value)) return 'unsupported_flag'
  if (/rate limit|too many requests|quota/.test(value)) return 'rate_limited'
  if (/overloaded|capacity|temporarily unavailable/.test(value)) return 'overloaded'
  if (/timeout|timed out/.test(value)) return 'timeout'
  if (/json|parse|output format/.test(value)) return 'bad_output'
  return 'unknown'
}

export async function probeProvider(id, { env = process.env, run = tryRun, now = () => new Date().toISOString() } = {}) {
  const definition = validProvider(id)
  const providerEnvironment = safeProviderEnvironment(id, env)
  const executable = await executableInPath(definition.binary, providerEnvironment)
  if (!executable) return {
    id, catalogVersion: PROVIDER_CATALOG_VERSION, checkedAt: now(), executable: { found: false, path: null, fingerprint: null },
    version: null, capabilities: null, status: 'unavailable', issue: 'binary_missing', detail: `${definition.binary} is not on PATH.`,
  }
  const stat = await fs.stat(executable)
  const fingerprint = `${executable}:${stat.size}:${Math.round(stat.mtimeMs)}`
  const version = run(executable, ['--version'], { timeout: 10000, maxBuffer: 1024 * 1024, shell: false, env: providerEnvironment })
  const help = run(executable, definition.helpArgs, { timeout: 10000, maxBuffer: 1024 * 1024, shell: false, env: providerEnvironment })
  const helpText = outputOf(help)
  const versionText = versionLine(version)
  const capabilities = {
    model: hasFlag(helpText, '--model') || /(?:^|\s)-m(?:[\s,]|$)/m.test(helpText),
    effort: hasFlag(helpText, '--effort'),
    stdinPrompt: true,
    structuredOutput: id === 'claude' ? hasFlag(helpText, '--output-format') : hasFlag(helpText, '--json'),
    safeInvocation: id === 'claude'
      ? ['--no-session-persistence', '--tools', '--strict-mcp-config'].every((flag) => hasFlag(helpText, flag)) && /(?:^|\s)--system-prompt(?:\[-file\]|-file)?\b/m.test(helpText)
      : ['--ephemeral', '--sandbox', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--output-last-message'].every((flag) => hasFlag(helpText, flag)),
  }
  const failure = version.error || help.error || (version.status !== 0 ? version : null) || (help.status !== 0 ? help : null)
  const missingRequiredCapabilities = Object.entries(capabilities)
    .filter(([name, supported]) => ['model', 'structuredOutput', 'safeInvocation'].includes(name) && !supported)
    .map(([name]) => name)
  return {
    id, catalogVersion: PROVIDER_CATALOG_VERSION, checkedAt: now(),
    executable: { found: true, path: executable, fingerprint }, version: versionText, capabilities,
    status: failure || missingRequiredCapabilities.length ? 'degraded' : 'available',
    issue: failure ? classifyProviderError(outputOf(failure)) : missingRequiredCapabilities.length ? 'unsupported_flag' : null,
    detail: failure ? outputOf(failure).slice(0, 1000) || `Exit status ${failure.status}` : missingRequiredCapabilities.length ? `The installed CLI did not advertise required capabilities: ${missingRequiredCapabilities.join(', ')}.` : null,
  }
}

export function providerCatalog() {
  return Object.values(PROVIDERS).map(({ id, label, binary, modelAliases, knownEfforts, supportsEffort, supportsReasoningEffort }) => ({
    id, label, binary, modelAliases, knownEfforts, supportsEffort, supportsReasoningEffort,
    modelPolicy: 'Aliases are convenience defaults; any provider model identifier is accepted and validated only on explicit test.',
  }))
}

export function formatAgentProfile(profile) {
  return [
    `Perfil: ${profile.name}`,
    `Proveedor: ${profile.provider}`,
    `Modelo: ${profile.model}`,
    `Effort (Claude): ${profile.effort || 'provider default'}`,
    `Reasoning effort (Codex): ${profile.reasoningEffort || 'provider default'}`,
    `Prompt: ${profile.prompt.path} (${profile.prompt.bytes} bytes, sha256 ${profile.prompt.sha256.slice(0, 12)}…)`,
    `Workspace: ${profile.workspace?.path || 'none (WhatsApp-only agent)'}`,
    `Timeout: ${profile.timeoutMs} ms`,
    `Actualizado: ${profile.updatedAt}`,
  ].join('\n')
}
