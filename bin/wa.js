#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import qrcodeTerminal from 'qrcode-terminal'
import { launchAgentLabel, launchAgentPlist } from '../src/launch-agent.js'
import { paths } from '../src/runtime-paths.js'
import { systemdServiceName, systemdUserUnit, systemdUserUnitPath } from '../src/systemd-service.js'
import { cachedCompatibleModels, defaultModelFor, selectLocalModel, transcriptionBackend } from '../src/transcription-runtime.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { dataDir, stateRoot, logsDir } = paths
const aliasesPath = path.join(dataDir, 'aliases.json')
const groupListsPath = path.join(dataDir, 'group-lists.json')
const tokenPath = path.join(dataDir, 'bridge-token')
const contactsSearchScript = path.join(root, 'bin', 'contacts-search.swift')
const baseUrl = 'http://127.0.0.1:3847'
const launchAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`)
const systemdUnitPath = systemdUserUnitPath({ home: os.homedir() })
const transcriptionConfigPath = path.join(dataDir, 'transcription.json')
const transcriptionVenvPath = path.join(stateRoot, 'transcribe-venv')
const transcriptionPythonPath = path.join(transcriptionVenvPath, 'bin', 'python')
const transcriptionScript = path.join(root, 'src', 'transcribe-audio.py')
const pullModelScript = path.join(root, 'src', 'pull-whisper-model.py')

function usage() {
  console.log(`WhatsApp Assistant — bridge local de contexto reciente

Inicio en una instalación nueva:
  brew tap diegomarvid/tap && brew install whatsapp-assistant
  wa setup                         # instala el daemon y muestra el QR si hace falta
  wa status                        # esperar: connection = open

Para agentes de IA:
  - Usar wa latest-incoming <contacto> para “el último mensaje que me mandó X”.
  - Usar wa coverage <contacto> antes de concluir que un chat está actualizado.
  - send, reply y react sólo ante instrucción explícita; el CLI no interpreta intención.
  - Estado privado: auth, SQLite y aliases quedan fuera de Homebrew.

Ayuda detallada: wa help [setup|messages|media|daemon|privacy]

Comandos:
  wa status
  wa doctor                         # estado, daemon, QR y rutas; no expone secretos
  wa setup
  wa qr                             # abre (macOS) o imprime (SSH) el QR pendiente
  wa daemon install|status|restart|uninstall
  wa migrate-state <old-project-directory>
  wa aliases
  wa alias add <alias> <phone> [display name]
  wa find <name or alias>
  wa recent [limit]
  wa groups list <list>
  wa groups find <list> [term...]
  wa groups inspect <group-jid> [limit]
  wa groups add <list> <group-jid> [reason]
  wa latest <alias or phone>
  wa latest-incoming <alias or phone>
  wa coverage <alias or phone>
  wa history <alias or phone> [limit] [--ids]
  wa search <alias or phone> <text>
  wa search-all <text> [--since 7d] [--direct|--groups <list>]
  wa pending [--since 24h]
  wa pending --groups <list> [--since 24h]
  wa transcribe <alias or phone> latest
  wa transcribe setup                # instala sólo el runtime Python privado
  wa transcribe doctor               # runtime y modelos locales, sin descargar
  wa transcribe pull [modelo]        # descarga un modelo explícitamente
  wa transcribe config show|model <id>|model-path <dir>
  wa audios <alias or phone> [limit]
  wa audio <alias or phone> <message-id>
  wa images <alias or phone> [limit]
  wa image <alias or phone> <message-id>
  wa files <alias or phone> [limit]
  wa file <alias or phone> <message-id>
  wa react <alias or phone> <message-id|latest|latest-incoming> <emoji>
  wa send <alias or phone> <message>
  wa reply <alias or phone> <message-id|latest|latest-incoming> <message>
  wa send-file <alias or phone> <file> [caption]`)
}

function help(topic) {
  const topics = {
    setup: `Instalación nueva:\n  macOS: brew tap diegomarvid/tap && brew install whatsapp-assistant\n  Linux: instalar Node 22+ y seguir la sección Linux/VPS del README de esta release.\n\n  1. wa setup\n  2. Escanear el QR que el comando abre (macOS) o imprime en la terminal (SSH) desde WhatsApp móvil: Ajustes → Dispositivos vinculados → Vincular un dispositivo.\n  3. wa status hasta ver connection = open.\n\nNo hace falta navegador. El bridge es un cliente vinculado de WhatsApp y conserva la sesión localmente.`,
    messages: `Lectura segura:\n  wa find "Nombre"\n  wa latest-incoming contacto --ids\n  wa history contacto 20 --ids\n  wa coverage contacto\n\nlatest incluye mensajes propios; latest-incoming sólo los recibidos. Para chats directos el CLI resuelve PN → LID actual antes de consultar.`,
    media: `Adjuntos:\n  wa audios contacto\n  wa audio contacto <message-id>\n  wa transcribe setup\n  wa transcribe doctor\n  wa transcribe contacto latest\n  wa images contacto\n  wa image contacto <message-id>\n  wa files contacto\n\nLa transcripción es opcional y local. setup instala el runtime Python aislado, pero nunca descarga un modelo sin wa transcribe pull explícito. image, file y audio devuelven paths para que la IA los abra con sus propias capacidades.`,
    daemon: `Servicio local:\n  wa daemon status\n  wa daemon restart\n  wa doctor\n\nEn macOS, setup instala un LaunchAgent. En Linux con systemd, instala un servicio de usuario. En ambos casos, mantenerlo activo permite recibir eventos nuevos. Un restart normal conserva auth y no necesita QR.\n\nEn un VPS Linux, habilitá linger una vez si querés que sobreviva al logout: sudo loginctl enable-linger $USER`,
    privacy: `Privacidad y límites:\n  - API sólo en 127.0.0.1.\n  - Retención móvil: 7 días, no historial completo.\n  - auth, SQLite, token y aliases no entran a Git ni Homebrew.\n  - No resetear auth ni pedir QR por un mensaje aparentemente viejo: usar doctor, status y coverage primero.`,
  }
  if (!topic) return usage()
  if (!topics[topic]) throw new Error(`Unknown help topic: ${topic}. Use: wa help setup|messages|media|daemon|privacy`)
  console.log(topics[topic])
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} failed`)
  return result.stdout?.trim() || ''
}

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

async function ensureRuntimeDirectories() {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await fs.chmod(stateRoot, 0o700)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fs.chmod(dataDir, 0o700)
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 })
  await fs.chmod(logsDir, 0o700)
}

function launchctlDomain() {
  return `gui/${process.getuid()}`
}

function linuxServiceDiagnostics() {
  const manager = tryRun('systemctl', ['--user', 'show-environment'])
  const linger = tryRun('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger', '--value'])
  return {
    type: 'systemd-user',
    name: systemdServiceName,
    unitExists: null,
    userManager: manager.status === 0 ? 'available' : null,
    linger: linger.status === 0 ? linger.stdout.trim() === 'yes' : null,
  }
}

async function installDaemon() {
  await ensureRuntimeDirectories()
  const serverPath = path.join(root, 'src', 'server.js')
  const entryPath = process.env.WA_DAEMON_ENTRY || serverPath
  const entryArguments = process.env.WA_DAEMON_ENTRY ? ['__daemon'] : []
  const nodePath = process.env.WA_DAEMON_NODE || process.execPath
  const workingDirectory = process.env.WA_DAEMON_CWD || path.dirname(serverPath)
  if (process.platform === 'linux') {
    await fs.mkdir(path.dirname(systemdUnitPath), { recursive: true, mode: 0o700 })
    const unit = systemdUserUnit({ nodePath, entryPath, entryArguments, stateRoot, logsDir, workingDirectory })
    await fs.writeFile(systemdUnitPath, unit, { mode: 0o600 })
    run('systemctl', ['--user', 'daemon-reload'])
    run('systemctl', ['--user', 'enable', '--now', systemdServiceName])
    return
  }
  if (process.platform !== 'darwin') throw new Error(`No managed daemon is available for ${process.platform}. Run the bridge with \`npm start\` under your process supervisor.`)
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true })
  const plist = launchAgentPlist({
    nodePath,
    serverPath,
    stateRoot,
    logsDir,
    entryPath,
    entryArguments,
    workingDirectory,
  })
  await fs.writeFile(launchAgentPath, plist, { mode: 0o600 })
  tryRun('launchctl', ['bootout', launchctlDomain(), launchAgentPath])
  run('launchctl', ['bootstrap', launchctlDomain(), launchAgentPath])
}

async function daemonStatus() {
  if (process.platform === 'linux') {
    const result = tryRun('systemctl', ['--user', 'status', '--no-pager', systemdServiceName])
    if (result.status !== 0) {
      console.log(`Daemon not installed or not running. Run: wa daemon install`)
      return
    }
    console.log(result.stdout.trim())
    return
  }
  if (process.platform !== 'darwin') throw new Error(`No managed daemon is available for ${process.platform}.`)
  const result = tryRun('launchctl', ['print', `${launchctlDomain()}/${launchAgentLabel}`])
  if (result.status !== 0) {
    console.log(`Daemon not installed or not running. Run: wa daemon install`)
    return
  }
  console.log(result.stdout.trim())
}

async function restartDaemon() {
  if (process.platform === 'linux') {
    if (!await fileExists(systemdUnitPath)) return installDaemon()
    run('systemctl', ['--user', 'restart', systemdServiceName])
    return
  }
  if (process.platform !== 'darwin') throw new Error(`No managed daemon is available for ${process.platform}.`)
  if (!await fileExists(launchAgentPath)) return installDaemon()
  run('launchctl', ['kickstart', '-k', `${launchctlDomain()}/${launchAgentLabel}`])
}

async function uninstallDaemon() {
  if (process.platform === 'linux') {
    tryRun('systemctl', ['--user', 'disable', '--now', systemdServiceName])
    await fs.rm(systemdUnitPath, { force: true })
    tryRun('systemctl', ['--user', 'daemon-reload'])
    return
  }
  if (process.platform !== 'darwin') throw new Error(`No managed daemon is available for ${process.platform}.`)
  tryRun('launchctl', ['bootout', launchctlDomain(), launchAgentPath])
  await fs.rm(launchAgentPath, { force: true })
}

async function fileExists(filename) {
  try { await fs.access(filename); return true } catch { return false }
}

async function waitForSetup(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  const qrPath = path.join(dataDir, 'link-qr.png')
  const qrTextPath = path.join(dataDir, 'link-qr.txt')
  while (Date.now() < deadline) {
    if (await fileExists(qrPath) || await fileExists(qrTextPath)) return { qrPath, health: null }
    try {
      const health = await request('/health')
      if (health.connection === 'open') return { qrPath: null, health }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { qrPath: await fileExists(qrPath) ? qrPath : null, health: null }
}

async function showQr() {
  const qrPath = path.join(dataDir, 'link-qr.png')
  const qrTextPath = path.join(dataDir, 'link-qr.txt')
  if (!await fileExists(qrPath) && !await fileExists(qrTextPath)) {
    console.log('No QR is pending. Run `wa status`; if the bridge is not open, run `wa doctor`.')
    return
  }
  console.log('Scan this QR in WhatsApp: Settings → Linked devices → Link a device')
  if (await fileExists(qrTextPath)) {
    qrcodeTerminal.generate((await fs.readFile(qrTextPath, 'utf8')).trim(), { small: true })
  }
  if (await fileExists(qrPath)) {
    console.log(qrPath)
    if (process.platform === 'darwin') tryRun('open', [qrPath])
  }
}

async function doctor() {
  let health = null
  try { health = await request('/health') } catch {}
  const daemon = process.platform === 'linux'
    ? { ...linuxServiceDiagnostics(), unitExists: await fileExists(systemdUnitPath) }
    : { type: 'launch-agent', label: launchAgentLabel, plistExists: await fileExists(launchAgentPath) }
  const nextStep = health?.connection === 'open'
    ? 'ready'
    : process.platform === 'linux' && daemon.userManager === null
      ? 'A systemd user manager is unavailable. Log in through systemd or run the bridge under the VPS supervisor.'
      : process.platform === 'linux' && daemon.linger === false
        ? 'Run `sudo loginctl enable-linger $USER` once so the bridge survives VPS logout and reboot, then run `wa setup`.'
        : 'Run `wa setup` for first link, or `wa daemon restart` for an existing session.'
  console.log(JSON.stringify({
    stateRoot,
    daemon,
    authExists: await fileExists(paths.authDir),
    sqliteExists: await fileExists(path.join(dataDir, 'mirror.sqlite')),
    qrPending: await fileExists(path.join(dataDir, 'link-qr.png')) || await fileExists(path.join(dataDir, 'link-qr.txt')),
    health,
    nextStep,
  }, null, 2))
}

async function setup() {
  await installDaemon()
  const { qrPath, health } = await waitForSetup()
  if (qrPath) {
    await showQr()
  } else if (health?.connection === 'open') {
    console.log('WhatsApp Assistant is linked and ready. Try: wa status')
  } else {
    console.log(`The bridge is still starting. Run: wa qr\nIf no QR appears, run: wa doctor`)
  }
}

function daemonDisplayName() {
  return process.platform === 'linux' ? systemdServiceName : launchAgentLabel
}

async function migrateState(sourceRoot) {
  if (!sourceRoot) return usage()
  const source = path.resolve(sourceRoot)
  if (source === stateRoot) throw new Error('The source is already the active WhatsApp Assistant state directory.')
  const sourceAuth = path.join(source, 'auth')
  const sourceData = path.join(source, 'data')
  if (!await fileExists(sourceAuth) || !await fileExists(sourceData)) throw new Error(`No auth/ and data/ directories found in ${source}`)
  if (await fileExists(paths.authDir) || await fileExists(path.join(dataDir, 'mirror.sqlite'))) throw new Error(`The target state already exists at ${stateRoot}. Refusing to overwrite it.`)
  await ensureRuntimeDirectories()
  await fs.cp(sourceAuth, paths.authDir, { recursive: true, errorOnExist: true })
  for (const entry of await fs.readdir(sourceData)) {
    await fs.cp(path.join(sourceData, entry), path.join(dataDir, entry), { recursive: true, force: false, errorOnExist: true })
  }
  console.log(`Migrated private state to ${stateRoot}. Run: wa setup`)
}

async function loadAliases() {
  try {
    return JSON.parse(await fs.readFile(aliasesPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveAliases(aliases) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${aliasesPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(aliases, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, aliasesPath)
}

async function loadGroupLists() {
  try {
    return JSON.parse(await fs.readFile(groupListsPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { lists: {} }
    throw error
  }
}

async function saveGroupLists(groupLists) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temp = `${groupListsPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(groupLists, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, groupListsPath)
}

function phoneToJid(value) {
  const digits = value.replace(/\D/g, '')
  if (!digits) throw new Error(`Invalid phone number: ${value}`)
  return `${digits}@s.whatsapp.net`
}

function phoneFromJid(jid) {
  return jid?.replace(/@.+$/, '').replace(/\D/g, '') || ''
}

function isDirectChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast')
}

function normalizeText(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function macContacts(args) {
  const result = spawnSync('swift', [contactsSearchScript, ...args], { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) return []
  try { return JSON.parse(result.stdout) } catch { return [] }
}

function macContactsForQuery(query) {
  return macContacts([query])
}

function macContactsForPhones(phones) {
  const uniquePhones = [...new Set(phones.filter(Boolean))]
  return uniquePhones.length ? macContacts(['--phones', ...uniquePhones]) : []
}

async function withCurrentJid(contact) {
  if (!contact?.jid || !contact.jid.endsWith('@s.whatsapp.net')) return contact
  const resolved = await request(`/resolve?jid=${encodeURIComponent(contact.jid)}`)
  return { ...contact, jid: resolved.jid || contact.jid, originalJid: contact.jid }
}

async function resolve(target) {
  const aliases = await loadAliases()
  const key = target.toLocaleLowerCase()
  const cache = await readSnapshot()
  if (aliases[key]) {
    const alias = aliases[key]
    const aliasMatches = Object.values(cache.chats).filter((chat) => normalizeText(chat.name || cache.contacts[chat.jid]?.name || '') === normalizeText(alias.name || ''))
    if (aliasMatches.length === 1) return withCurrentJid({ ...alias, jid: aliasMatches[0].jid, alias: key })
    return withCurrentJid({ ...alias, alias: key })
  }
  if (/^[^@\s]+@(s\.whatsapp\.net|lid|g\.us|broadcast)$/i.test(target)) return withCurrentJid({ phone: phoneFromJid(target), jid: target, alias: null, name: null })
  if (/^[+\d][\d\s()-]*$/.test(target)) return withCurrentJid({ phone: target.replace(/\D/g, ''), jid: phoneToJid(target), alias: null, name: null })
  const normalizedTarget = normalizeText(target)
  const whatsappMatches = Object.values(cache.chats).filter((chat) => normalizeText(chat.name || cache.contacts[chat.jid]?.name || '') === normalizedTarget)
  if (whatsappMatches.length === 1) return withCurrentJid({ phone: phoneFromJid(whatsappMatches[0].jid), jid: whatsappMatches[0].jid, alias: null, name: whatsappMatches[0].name || cache.contacts[whatsappMatches[0].jid]?.name || null })
  if (whatsappMatches.length > 1) throw new Error(`More than one WhatsApp chat matches “${target}”. Use a phone number or save an alias.`)
  const exactMatches = macContactsForQuery(target)
    .filter((match) => normalizeText(match.name) === normalizeText(target))
  const phones = [...new Set(exactMatches.flatMap((match) => match.phones.map((phone) => phone.replace(/\D/g, '')).filter(Boolean)))]
  if (phones.length === 1) return withCurrentJid({ phone: phones[0], jid: phoneToJid(phones[0]), alias: null, name: exactMatches[0].name })
  if (phones.length > 1) throw new Error(`More than one contact matches “${target}”. Use a phone number or save an alias.`)
  throw new Error(`Unknown alias “${target}”. Run: wa alias add ${target} <phone> "Name"`)
}

async function request(endpoint) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  let response
  try {
    response = await fetch(`${baseUrl}${endpoint}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  } catch (error) {
    throw new Error(`WhatsApp observer unavailable: ${error.name === 'TimeoutError' ? 'request timed out' : error.message}`)
  }
  if (!response.ok) throw new Error(`Bridge request failed (${response.status}): ${await response.text()}`)
  return response.json()
}

async function readSnapshot() {
  return request('/snapshot')
}

async function requireFreshCoverage(contact) {
  const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
  if (!coverage.fresh) {
    throw new Error(`Latest selector is unavailable because this chat is not freshly synchronized (${coverage.reasons.join(', ')}). Run: wa coverage ${contact.alias || contact.name || contact.phone || contact.jid}`)
  }
  return coverage
}

async function whatsappGroups() {
  const { groups } = await request('/groups')
  return groups || []
}

async function downloadAudio(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/audio/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download audio: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function downloadImage(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/images/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download image: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function downloadDocument(jid, messageId) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/documents/download?jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Could not download document: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function reactToMessage(jid, messageId, emoji) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/messages/react`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jid, messageId, emoji }) })
  if (!response.ok) throw new Error(`Could not react: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function sendMessage(jid, text, replyToMessageId = null) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jid, text, replyToMessageId }),
  })
  if (!response.ok) throw new Error(`Could not send message: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function sendFile(jid, filePath, caption) {
  const token = (await fs.readFile(tokenPath, 'utf8')).trim()
  const response = await fetch(`${baseUrl}/documents/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jid, filePath, caption }),
  })
  if (!response.ok) throw new Error(`Could not send document: ${(await response.json()).message || response.status}`)
  return response.json()
}

async function loadTranscriptionConfig() {
  try { return JSON.parse(await fs.readFile(transcriptionConfigPath, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveTranscriptionConfig(config) {
  await ensureRuntimeDirectories()
  await fs.writeFile(transcriptionConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function pythonForSetup() {
  const candidates = [process.env.WA_PYTHON, 'python3'].filter(Boolean)
  for (const candidate of candidates) {
    const result = tryRun(candidate, ['-c', 'import sys; print(sys.executable)'])
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  }
  return null
}

function activeTranscriptionRuntime(config) {
  const backend = transcriptionBackend()
  const selected = selectLocalModel({ backend, configuredModel: config.model, home: os.homedir() })
  return { backend, selected, defaultModel: defaultModelFor(backend), runtimeInstalled: existsSync(transcriptionPythonPath) }
}

async function transcriptionDoctor() {
  const config = await loadTranscriptionConfig()
  const runtime = activeTranscriptionRuntime(config)
  const ffmpegAvailable = tryRun('ffmpeg', ['-version']).status === 0
  console.log(JSON.stringify({
    ...runtime,
    configuredModel: config.model || null,
    runtimePath: transcriptionPythonPath,
    ffmpegAvailable,
    cachedCompatibleModels: cachedCompatibleModels(runtime.backend, { home: os.homedir() }),
    downloadsModelsAutomatically: false,
    nextStep: !runtime.runtimeInstalled
      ? 'Run `wa transcribe setup` to create a private Python runtime. This does not download a model.'
      : runtime.backend === 'mlx' && !ffmpegAvailable
        ? 'Install ffmpeg (for example, `brew install ffmpeg`) before transcribing audio on Apple Silicon.'
      : !runtime.selected
        ? `Ask the user before downloading ${runtime.defaultModel}, then run \`wa transcribe pull ${runtime.defaultModel}\`, or configure an existing directory with \`wa transcribe config model-path <dir>\`.`
        : 'ready',
  }, null, 2))
}

async function setupTranscription({ verbose = true } = {}) {
  await ensureRuntimeDirectories()
  const backend = transcriptionBackend()
  if (!existsSync(transcriptionPythonPath)) {
    const python = pythonForSetup()
    if (!python) throw new Error('Python 3 is required for local transcription. Install Python 3, then run `wa transcribe setup`.')
    run(python, ['-m', 'venv', transcriptionVenvPath])
  }
  run(transcriptionPythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  const dependencies = backend === 'mlx' ? ['mlx-whisper', 'huggingface-hub'] : ['faster-whisper', 'huggingface-hub']
  run(transcriptionPythonPath, ['-m', 'pip', 'install', ...dependencies])
  if (verbose) {
    console.log(`Installed ${backend} in ${transcriptionVenvPath}. No Whisper model was downloaded.`)
    await transcriptionDoctor()
  }
}

async function pullTranscriptionModel(requestedModel) {
  const config = await loadTranscriptionConfig()
  const runtime = activeTranscriptionRuntime(config)
  if (!runtime.runtimeInstalled) throw new Error('Run `wa transcribe setup` before downloading a model.')
  const model = requestedModel || config.model || runtime.defaultModel
  if (path.isAbsolute(model)) throw new Error('A local model path cannot be downloaded. Configure a Hugging Face model ID instead.')
  console.log(`Downloading Whisper model ${model}...`)
  const result = run(transcriptionPythonPath, [pullModelScript, model], { timeout: 30 * 60 * 1000 })
  await saveTranscriptionConfig({ ...config, model })
  console.log(result)
}

async function configureTranscription(args) {
  const action = args.shift()
  if (action === 'show') return transcriptionDoctor()
  const value = args.join(' ').trim()
  if (!value || !['model', 'model-path'].includes(action)) throw new Error('Use: wa transcribe config show|model <huggingface-id>|model-path <directory>')
  if (action === 'model-path') {
    const absolutePath = path.resolve(value)
    const stat = await fs.stat(absolutePath).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`Model directory not found: ${absolutePath}`)
    await saveTranscriptionConfig({ model: absolutePath })
    return console.log(`Configured local Whisper model: ${absolutePath}`)
  }
  if (!/^[^\s/]+\/[^\s/]+$/.test(value)) throw new Error('Use a Hugging Face model ID such as mlx-community/whisper-large-v3-turbo.')
  await saveTranscriptionConfig({ model: value })
  console.log(`Configured Whisper model: ${value}. It will not download until you run wa transcribe pull.`)
}

async function transcribe(audioPath) {
  const config = await loadTranscriptionConfig()
  let runtime = activeTranscriptionRuntime(config)
  if (!runtime.runtimeInstalled) {
    await setupTranscription({ verbose: false })
    runtime = activeTranscriptionRuntime(config)
  }
  if (!runtime.selected) throw new Error(`No compatible Whisper model is installed locally. Ask the user before downloading ${runtime.defaultModel}; then run: wa transcribe pull ${runtime.defaultModel}`)
  const result = run(transcriptionPythonPath, [transcriptionScript, runtime.backend, runtime.selected.path, 'es', audioPath], { timeout: 10 * 60 * 1000 })
  return result.trim()
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' }).format(new Date(timestamp * 1000))
}

function printMessages(messages, { ids = false } = {}) {
  if (!messages.length) return console.log('No hay mensajes cacheados para este chat.')
  for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
    const author = message.fromMe ? 'Vos' : 'Contacto'
    const text = message.text || `[${message.type}]`
    const context = [message.quotedMessageId ? `↪ ${message.quotedMessageId}` : null, message.reactionToMessageId ? `reacción ${message.reactionText || ''} a ${message.reactionToMessageId}` : null].filter(Boolean).join(' · ')
    const source = message.source === 'live' ? '' : ' [cache histórico]'
    console.log(`${formatTime(message.timestamp)} — ${author}: ${text}${context ? ` (${context})` : ''}${ids ? ` [id: ${message.id}]` : ''}${source}`)
  }
}

async function cacheMatches(query) {
  const cache = await readSnapshot()
  const normalized = normalizeText(query)
  const signals = new Map()
  for (const chat of Object.values(cache.chats)) {
    if (!isDirectChat(chat.jid)) continue
    signals.set(chat.jid, {
      jid: chat.jid,
      names: new Set([chat.name, cache.contacts[chat.jid]?.name].filter(Boolean)),
      messageCount: 0,
      lastTimestamp: chat.lastTimestamp || 0,
      matchingText: null,
    })
  }
  for (const message of cache.messages) {
    if (!isDirectChat(message.jid)) continue
    const signal = signals.get(message.jid) || {
      jid: message.jid,
      names: new Set(),
      messageCount: 0,
      lastTimestamp: 0,
      matchingText: null,
    }
    if (message.pushName) signal.names.add(message.pushName)
    signal.messageCount += 1
    signal.lastTimestamp = Math.max(signal.lastTimestamp, message.timestamp || 0)
    if (!signal.matchingText && normalized && normalizeText(message.text || '').includes(normalized)) signal.matchingText = message.text
    signals.set(message.jid, signal)
  }
  return [...signals.values()]
    .map((signal) => {
      const names = [...signal.names]
      const name = names[0] || null
      const matchingName = names.find((candidate) => normalizeText(candidate).includes(normalized))
      const score = matchingName
        ? (normalizeText(matchingName) === normalized ? 900 : 700)
        : signal.matchingText ? 200 : 0
      return { ...signal, name, matchingName, score }
    })
    .filter((signal) => signal.score > 0)
    .sort((left, right) => right.score - left.score || right.lastTimestamp - left.lastTimestamp)
}

async function recentChats(limit) {
  const cache = await readSnapshot()
  const chats = Object.values(cache.chats)
    .filter((chat) => isDirectChat(chat.jid))
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
    .slice(0, limit)
  const contacts = macContactsForPhones(chats.map((chat) => phoneFromJid(chat.jid)))
  const contactByPhone = new Map(contacts.flatMap((contact) => contact.phones.map((phone) => [phone.replace(/\D/g, ''), contact.name])))
  return { cache, chats, contactByPhone }
}

async function groupCandidates(terms) {
  const normalizedTerms = terms.map(normalizeText).filter(Boolean)
  const [groups, cache] = await Promise.all([
    whatsappGroups(),
    readSnapshot(),
  ])
  const messagesByGroup = new Map()
  for (const message of cache.messages) {
    if (!message.jid?.endsWith('@g.us')) continue
    const text = message.text || ''
    const matchingTerm = normalizedTerms.find((term) => normalizeText(text).includes(term))
    if (!matchingTerm) continue
    const evidence = messagesByGroup.get(message.jid) || []
    evidence.push({ text, timestamp: message.timestamp, matchingTerm })
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

function printKnownGroup(group) {
  console.log(`conocido: ${group.subject || 'sin título'} (${group.jid})${group.reason ? ` — ${group.reason}` : ''}`)
}

function discoveryTerms(list, listName, extras = []) {
  const stopWords = new Set(['maspeak', 'con', 'para', 'las', 'los', 'del', 'una', 'uno', 'ops'])
  const inferred = (list.groups || []).flatMap((group) => (group.subject || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeText)
    .filter((term) => term.length >= 4 && !stopWords.has(term)))
  return [...new Set([...(list.terms || []), listName, ...extras, ...inferred])]
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') return usage()
  if (command === 'help') return help(args[0])
  if (command === '__daemon') return import('../src/server.js')
  if (command === 'doctor') return doctor()
  if (command === 'qr') return showQr()
  if (command === 'setup') return setup()
  if (command === 'transcribe' && args[0] === 'setup') return setupTranscription()
  if (command === 'transcribe' && args[0] === 'doctor') return transcriptionDoctor()
  if (command === 'transcribe' && args[0] === 'pull') return pullTranscriptionModel(args[1])
  if (command === 'transcribe' && args[0] === 'config') return configureTranscription(args.slice(1))
  if (command === 'migrate-state') return migrateState(args[0])
  if (command === 'daemon') {
    const action = args[0]
    if (action === 'install') { await installDaemon(); return console.log(`Daemon installed: ${daemonDisplayName()}`) }
    if (action === 'status') return daemonStatus()
    if (action === 'restart') { await restartDaemon(); return console.log('Daemon restarted.') }
    if (action === 'uninstall') { await uninstallDaemon(); return console.log('Daemon removed. Private state was preserved.') }
    return usage()
  }
  if (command === 'status') return console.log(JSON.stringify(await request('/health'), null, 2))
  if (command === 'aliases') {
    const aliases = await loadAliases()
    const entries = Object.entries(aliases)
    if (!entries.length) return console.log('No hay aliases guardados.')
    for (const [alias, item] of entries) console.log(`${alias} → ${item.name || item.phone} (${item.phone})`)
    return
  }
  if (command === 'alias' && args[0] === 'add') {
    const [_, alias, phone, ...name] = args
    if (!alias || !phone) return usage()
    const aliases = await loadAliases()
    const key = alias.toLocaleLowerCase()
    aliases[key] = { phone: phone.replace(/\D/g, ''), jid: phoneToJid(phone), name: name.join(' ') || null }
    await saveAliases(aliases)
    return console.log(`Alias saved: ${key} → ${aliases[key].name || aliases[key].phone}`)
  }
  if (command === 'find') {
    const query = args.join(' ').trim()
    if (!query) return usage()
    const aliases = await loadAliases()
    const aliasHits = Object.entries(aliases).filter(([alias, item]) => `${alias} ${item.name || ''} ${item.phone}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const chatHits = await cacheMatches(query)
    const contactHits = macContactsForQuery(query)
    for (const [alias, item] of aliasHits) console.log(`alias: ${alias} → ${item.name || item.phone} (${item.phone})`)
    for (const chat of chatHits) {
      const identity = chat.matchingName || chat.name || 'sin nombre'
      const evidence = chat.matchingName
        ? `coincide con nombre de WhatsApp; ${chat.messageCount} mensajes recientes`
        : `menciona “${chat.matchingText.slice(0, 90)}”; ${chat.messageCount} mensajes recientes`
      console.log(`WhatsApp: ${identity} (${chat.jid}) — ${evidence}`)
    }
    for (const contact of contactHits) console.log(`contacto: ${contact.name} (${contact.phones.join(', ')})`)
    if (!aliasHits.length && !chatHits.length && !contactHits.length) console.log('Sin coincidencias.')
    return
  }
  if (command === 'recent') {
    const limit = Math.min(Math.max(Number.parseInt(args[0] || '20', 10) || 20, 1), 50)
    const { cache, chats, contactByPhone } = await recentChats(limit)
    const aliases = await loadAliases()
    const aliasByPhone = new Map(Object.values(aliases).map((item) => [item.phone, item.name || item.phone]))
    for (const chat of chats) {
      const phone = phoneFromJid(chat.jid)
      const name = aliasByPhone.get(phone) || cache.contacts[chat.jid]?.name || chat.name || contactByPhone.get(phone) || 'sin nombre'
      console.log(`${formatTime(chat.lastTimestamp)} — ${name} (${phone || chat.jid})`)
    }
    return
  }
  if (command === 'groups') {
    const action = args.shift()
    if (!action || !['list', 'find', 'inspect', 'add'].includes(action)) return usage()
    if (action === 'inspect') {
      const jid = args.shift()
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '12', 10) || 12, 1), 50)
      if (!jid) return usage()
      const [groups, cache] = await Promise.all([whatsappGroups(), readSnapshot()])
      const group = groups.find((item) => item.jid === jid)
      if (!group) throw new Error(`Unknown WhatsApp group: ${jid}`)
      console.log(`Grupo: ${group.subject || 'sin título'} (${group.jid})`)
      if (group.desc) console.log(`Descripción: ${group.desc}`)
      const messages = cache.messages
        .filter((message) => message.jid === jid && message.text?.trim())
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, limit)
      for (const message of messages) console.log(`${formatTime(message.timestamp)} — ${message.fromMe ? 'Vos' : message.pushName || 'Contacto'}: ${message.text.slice(0, 500)}`)
      return
    }
    const listName = args.shift()?.toLocaleLowerCase()
    if (!listName) return usage()
    const groupLists = await loadGroupLists()
    const list = groupLists.lists[listName] || { terms: [listName], groups: [] }
    if (action === 'list') {
      if (!list.groups.length) return console.log(`No hay grupos guardados para ${listName}.`)
      list.groups.forEach(printKnownGroup)
      return
    }
    const groups = await whatsappGroups()
    if (action === 'add') {
      const jid = args.shift()
      const reason = args.join(' ').trim() || 'confirmado manualmente'
      const group = groups.find((item) => item.jid === jid)
      if (!group) throw new Error(`Unknown WhatsApp group: ${jid}`)
      const existing = list.groups.find((item) => item.jid === jid)
      if (existing) Object.assign(existing, { subject: group.subject, reason, lastSeenAt: new Date().toISOString() })
      else list.groups.push({ jid, subject: group.subject, reason, addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
      list.terms = discoveryTerms(list, listName)
      groupLists.lists[listName] = list
      await saveGroupLists(groupLists)
      return printKnownGroup(list.groups.find((item) => item.jid === jid))
    }
    const terms = discoveryTerms(list, listName, args)
    const candidates = await groupCandidates(terms)
    const knownIds = new Set(list.groups.map((group) => group.jid))
    if (list.groups.length) {
      console.log(`Grupos conocidos de ${listName}:`)
      list.groups.forEach(printKnownGroup)
    }
    const newCandidates = candidates.filter((group) => !knownIds.has(group.jid))
    if (newCandidates.length) {
      console.log(`Candidatos nuevos de ${listName}:`)
      for (const group of newCandidates) {
        const evidence = group.metadataMatches.length
          ? `coincide en título/descripción: ${group.metadataMatches.join(', ')}`
          : `${group.evidence.length} mensajes con ${group.evidence[0].matchingTerm}`
        console.log(`candidato: ${group.subject || 'sin título'} (${group.jid}) — ${evidence}; revisar: wa groups inspect ${group.jid}`)
      }
    }
    if (!list.groups.length && !newCandidates.length) console.log(`No encontré grupos candidatos para ${listName}.`)
    return
  }
  if (command === 'send') {
    const target = args.shift()
    const text = args.join(' ').trim()
    if (!target || !text) return usage()
    const contact = await resolve(target)
    const result = await sendMessage(contact.jid, text)
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'reply') {
    const target = args.shift()
    const selector = args.shift()
    const text = args.join(' ').trim()
    if (!target || !selector || !text) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    const quoted = selector === 'latest' ? messages[0] : selector === 'latest-incoming' ? messages.find((message) => !message.fromMe) : messages.find((message) => message.id === selector)
    if (!quoted) throw new Error(`No matching message found for reply selector: ${selector}`)
    if (selector === 'latest' || selector === 'latest-incoming') await requireFreshCoverage(contact)
    const result = await sendMessage(contact.jid, text, quoted.id)
    return console.log(`Reply sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'send-file') {
    const target = args.shift()
    const filePath = args.shift()
    const caption = args.join(' ').trim()
    if (!target || !filePath) return usage()
    const file = path.resolve(filePath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
    const contact = await resolve(target)
    const result = await sendFile(contact.jid, file, caption)
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}.`)
  }
  if (command === 'search-all') {
    const query = args.shift()?.trim()
    if (!query) return usage()
    let sinceSeconds = 0
    let scope = 'all'
    let groupList = null
    while (args.length) {
      const option = args.shift()
      if (option === '--since') {
        const value = args.shift() || ''
        const match = value.match(/^(\d+)(h|d)$/)
        if (!match) throw new Error('Use --since <n>h or <n>d')
        sinceSeconds = Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
      } else if (option === '--direct') scope = 'direct'
      else if (option === '--groups') { scope = 'groups'; groupList = args.shift() || null }
      else throw new Error(`Unknown option: ${option}`)
    }
    const cache = await readSnapshot()
    const allowedGroups = groupList ? new Set((await loadGroupLists()).lists[groupList]?.groups?.map((group) => group.jid) || []) : null
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds
    const matches = cache.messages.filter((message) => message.timestamp >= cutoff && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (scope === 'all' || (scope === 'direct' && isDirectChat(message.jid)) || (scope === 'groups' && message.jid.endsWith('@g.us') && (!allowedGroups || allowedGroups.has(message.jid))))).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100)
    return printMessages(matches)
  }
  if (command === 'pending') {
    let sinceSeconds = 86400
    let groupList = null
    while (args.length) {
      const option = args.shift()
      if (option === '--since') {
        const match = (args.shift() || '').match(/^(\d+)(h|d)$/)
        if (!match) throw new Error('Use --since <n>h or <n>d')
        sinceSeconds = Number(match[1]) * (match[2] === 'd' ? 86400 : 3600)
      } else if (option === '--groups') {
        groupList = args.shift()?.toLocaleLowerCase()
        if (!groupList) throw new Error('Use --groups <list>')
      } else throw new Error(`Unknown option: ${option}`)
    }
    const cache = await readSnapshot()
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds
    if (groupList) {
      const list = (await loadGroupLists()).lists[groupList]
      if (!list?.groups?.length) return console.log(`No hay grupos guardados para ${groupList}.`)
      const reviews = list.groups
        .map((group) => ({ group, messages: cache.messages.filter((message) => message.jid === group.jid).sort((a, b) => b.timestamp - a.timestamp) }))
        .filter(({ messages }) => messages[0] && !messages[0].fromMe && messages[0].timestamp >= cutoff)
      if (!reviews.length) return console.log(`No hay mensajes entrantes recientes como último intercambio en grupos de ${groupList}.`)
      for (const { group, messages } of reviews) {
        const message = messages[0]
        console.log(`${formatTime(message.timestamp)} — ${group.subject || group.jid}: ${message.text.slice(0, 500)} [id: ${message.id}]`)
      }
      return
    }
    const open = Object.values(cache.chats).filter((chat) => isDirectChat(chat.jid)).map((chat) => ({ chat, messages: cache.messages.filter((message) => message.jid === chat.jid).sort((a, b) => b.timestamp - a.timestamp) })).filter(({ messages }) => messages[0] && !messages[0].fromMe && messages[0].timestamp >= cutoff)
    if (!open.length) return console.log('No hay chats directos recientes pendientes de respuesta.')
    for (const { chat, messages } of open) { const message = messages[0]; console.log(`${formatTime(message.timestamp)} — ${cache.contacts[chat.jid]?.name || chat.name || phoneFromJid(chat.jid) || 'sin nombre'}: ${(message.text || `[${message.type}]`).slice(0, 500)}`) }
    return
  }
  if (command === 'latest' || command === 'latest-incoming' || command === 'coverage' || command === 'history' || command === 'search' || command === 'transcribe' || command === 'audios' || command === 'audio' || command === 'images' || command === 'image' || command === 'files' || command === 'file' || command === 'react') {
    const target = args.shift()
    if (!target) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    if (command === 'coverage') {
      const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
      console.log(JSON.stringify({ chat: contact.name || target, ...coverage }, null, 2))
      return
    }
    if (command === 'latest' || command === 'latest-incoming') {
      await requireFreshCoverage(contact)
      const latest = command === 'latest-incoming' ? messages.find((message) => !message.fromMe) : messages[0]
      if (!latest) return console.log('No hay mensajes entrantes cacheados para este chat.')
      return printMessages([latest], { ids: args.includes('--ids') })
    }
    if (command === 'history') {
      await requireFreshCoverage(contact)
      const limit = Number.parseInt(args.find((argument) => argument !== '--ids') || '20', 10)
      return printMessages(messages.slice(0, limit), { ids: args.includes('--ids') })
    }
    if (command === 'transcribe' || command === 'audio') {
      const audioId = args[0] || 'latest'
      const audio = audioId === 'latest' ? messages.find((message) => message.type === 'audioMessage') : messages.find((message) => message.type === 'audioMessage' && message.id === audioId)
      if (!audio) return console.log('No hay un audio cacheado para este chat.')
      const { audio: downloaded } = await downloadAudio(contact.jid, audio.id)
      if (command === 'audio') return console.log(downloaded.path)
      console.log(await transcribe(downloaded.path))
      return
    }
    if (command === 'audios') {
      const audios = messages.filter((message) => message.type === 'audioMessage').slice(0, Number.parseInt(args[0] || '20', 10))
      if (!audios.length) return console.log('No hay audios cacheados para este chat.')
      for (const audio of audios) console.log(`${formatTime(audio.timestamp)} — ${audio.id} (${audio.audioRef ? 'disponible' : 'sin captura local'})`)
      return
    }
    if (command === 'images') {
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '20', 10) || 20, 1), 50)
      const images = messages.filter((message) => message.type === 'imageMessage').slice(0, limit)
      if (!images.length) return console.log('No hay imágenes cacheadas para este chat.')
      for (const image of images) {
        const availability = image.imageRef ? 'disponible' : 'sin captura local'
        const caption = image.text ? ` — ${image.text.slice(0, 500)}` : ''
        console.log(`${formatTime(image.timestamp)} — ${image.id} (${availability})${caption}`)
      }
      return
    }
    if (command === 'image') {
      const messageId = args.shift()
      if (!messageId) return usage()
      const { image } = await downloadImage(contact.jid, messageId)
      return console.log(image.path)
    }
    if (command === 'files' || command === 'file') {
      const files = messages.filter((message) => message.type === 'documentMessage')
      if (command === 'files') {
        const shown = files.slice(0, Number.parseInt(args[0] || '20', 10))
        if (!shown.length) return console.log('No hay archivos cacheados para este chat.')
        for (const file of shown) console.log(`${formatTime(file.timestamp)} — ${file.id} (${file.documentRef ? 'disponible' : 'sin captura local'}) — ${file.documentName || file.documentMimetype || 'archivo'}`)
        return
      }
      const messageId = args.shift()
      if (!messageId) return usage()
      const { document } = await downloadDocument(contact.jid, messageId)
      return console.log(document.path)
    }
    if (command === 'react') {
      const selector = args.shift(); const emoji = args.shift()
      if (!selector || !emoji) return usage()
      const message = selector === 'latest' ? messages[0] : selector === 'latest-incoming' ? messages.find((item) => !item.fromMe) : messages.find((item) => item.id === selector)
      if (!message) throw new Error(`No matching message found for reaction selector: ${selector}`)
      if (selector === 'latest' || selector === 'latest-incoming') await requireFreshCoverage(contact)
      await reactToMessage(contact.jid, message.id, emoji)
      return console.log('Reaction sent.')
    }
    const query = args.join(' ').trim().toLocaleLowerCase()
    if (!query) return usage()
    return printMessages(messages.filter((message) => message.text.toLocaleLowerCase().includes(query)))
  }
  usage()
}

main().catch((error) => {
  console.error(`wa: ${error.message}`)
  process.exitCode = 1
})
