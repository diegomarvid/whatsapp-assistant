#!/usr/bin/env node

// Thin CLI entry point: command parsing, help text and the dispatcher.
// Bridge I/O, identity resolution, formatting, daemon control and
// transcription live in single-purpose modules under src/.
import fs from 'node:fs/promises'
import path from 'node:path'
import qrcodeTerminal from 'qrcode-terminal'
import {
  downloadAudio, downloadDocument, downloadImage, downloadSticker, downloadVideo,
  editMessage, markMessageRead, reactToMessage, readIdentities, request,
  requireFreshCoverage, resolveMessageSelector, revokeMessage,
  sendFile, sendMedia, sendMessage, whatsappGroup, whatsappGroups,
} from '../src/bridge-client.js'
import { contactIdentity, formatTime, groupReceiptReport, linksForMessage, pollReport, printMessages } from '../src/cli-format.js'
import { cacheMatches, loadAliases, phoneFromJid, phoneToJid, recentChats, resolveContact as resolve, saveAliases } from '../src/contact-resolve.js'
import { daemonDisplayName, daemonStatus, installDaemon, launchAgentPath, lingerInstruction, linuxServiceDiagnostics, restartDaemon, systemdUnitPath, uninstallDaemon } from '../src/daemon-control.js'
import { tryRun } from '../src/exec.js'
import { discoveryTerms, groupCandidates, loadGroupLists, printKnownGroup, saveGroupLists } from '../src/group-lists.js'
import { DEFAULT_HISTORY_POLICY, MAX_RETENTION_DAYS, historyPolicyForDays, historyPolicyPath, loadHistoryPolicy, saveHistoryPolicy } from '../src/history-policy.js'
import { launchAgentLabel } from '../src/launch-agent.js'
import { macContactsForQuery } from '../src/mac-contacts.js'
import { paths, projectRoot } from '../src/runtime-paths.js'
import { PendingOutboundRequests } from '../src/pending-outbound-requests.js'
import { parseSince } from '../src/search-scope.js'
import { ensureRuntimeDirectories, fileExists } from '../src/state-dirs.js'
import { configureTranscription, pullTranscriptionModel, setupTranscription, transcribe, transcriptionDoctor } from '../src/transcription.js'

const packageInfo = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const npmInstallCommand = `npm install -g ${packageInfo.name}`
const { dataDir, stateRoot } = paths
const pendingOutboundRequests = new PendingOutboundRequests(path.join(dataDir, 'pending-outbound-requests.json'))

function outboundDestination(contact) {
  return contact.phone || contact.originalJid || contact.jid
}

async function sendOnce(operation, send) {
  const pending = await pendingOutboundRequests.claim(operation)
  const result = await send(pending.requestId)
  if (result.pending) {
    throw new Error(`The previous send is still unconfirmed (request ${pending.requestId}). It was not sent again; verify it with the recipient before requesting an explicit new send.`)
  }
  await pendingOutboundRequests.complete(pending.fingerprint)
  return result
}

function usage() {
  console.log(`WhatsApp Assistant — bridge local de contexto reciente

Inicio en una instalación nueva:
  brew tap diegomarvid/tap && brew install whatsapp-assistant
  wa setup                         # instala el daemon y muestra el QR si hace falta
  wa status                        # esperar: connection = open

Linux / VPS (Node 22+ y systemd):
  # Si falta Node 22+, instalarlo como usuario normal:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  . "$HOME/.nvm/nvm.sh" && nvm install 22
  ${npmInstallCommand}
  wa setup                         # imprime el QR en una sesión SSH
  sudo loginctl enable-linger "$USER"  # una vez; sobrevive logout/reboot
  wa doctor

Para agentes de IA:
  - Usar wa latest-incoming <contacto> para “el último mensaje que me mandó X”.
  - Usar wa coverage <contacto> antes de concluir que un chat está actualizado.
  - send, reply y react sólo ante instrucción explícita; el CLI no interpreta intención.
  - Estado privado: auth, SQLite y aliases quedan fuera de Homebrew.

Ayuda detallada: wa help [setup|messages|data|media|daemon|privacy]

Comandos:
  wa status
  wa doctor                         # estado, daemon, QR y rutas; no expone secretos
  wa setup
  wa history-policy show|set <days|all>
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
  wa groups participants <group-jid>
  wa groups add <list> <group-jid> [reason]
  wa latest <alias or phone>
  wa latest-incoming <alias or phone>
  wa coverage <alias or phone>
  wa history-policy show|set <days|all>
  wa help data                       # qué datos recientes son históricos y cuáles requieren observación activa
  wa history <alias or phone> [limit] [--ids]
  wa search <alias or phone> <text>
  wa search-all <text> [--since 7d] [--direct|--groups <list>] [--ids]
  wa transcribe <alias or phone> latest
  wa transcribe setup                # instala sólo el runtime Python privado
  wa transcribe doctor               # runtime y modelos locales, sin descargar
  wa transcribe pull [modelo]        # descarga un modelo explícitamente
  wa transcribe config show|model <id>|model-path <dir>|language <code|auto>
  wa audios <alias or phone> [limit]
  wa audio <alias or phone> <message-id>
  wa images <alias or phone> [limit]
  wa image <alias or phone> <message-id>
  wa videos <alias or phone> [limit]
  wa video <alias or phone> <message-id>
  wa stickers <alias or phone> [limit]
  wa sticker <alias or phone> <message-id>
  wa files <alias or phone> [limit]
  wa file <alias or phone> <message-id>
  wa locations|contacts|polls|calls|links <alias or phone> [limit]
  wa poll <alias or phone> <message-id>
  wa group-events <group> [limit]
  wa message|delivery|receipts|reactions <alias or phone> <message-id>
  wa unread-by <group> <message-id>    # sin read receipt = sin confirmación, no “no lo vio”
  wa react <alias or phone> <message-id|latest|latest-incoming> <emoji>
  wa send <alias or phone> <message> [--mention <contacto> ...]
  wa reply <alias or phone> <message-id|latest|latest-incoming> <message>
  wa edit <alias or phone> <message-id|latest> <new text>      # sólo mensajes propios
  wa unsend <alias or phone> <message-id|latest>               # revoca un mensaje propio
  wa mark-read <alias or phone> <message-id|latest-incoming>   # emite read receipt explícito
  wa send-file <alias or phone> <file> [caption] [--reply-to <id|latest-incoming>]
  wa send-image|send-video <alias or phone> <file> [caption] [--mention <contacto> ...] [--reply-to <id|latest-incoming>]
  wa send-audio <alias or phone> <file> [--voice] [--reply-to <id|latest-incoming>]`)
}

function help(topic) {
  const topics = {
    setup: `Instalación nueva:\n  macOS:\n    brew tap diegomarvid/tap && brew install whatsapp-assistant\n    wa setup                       # pregunta 7 días o retención extendida\n\n  Linux / VPS (requiere systemd):\n    # Si falta Node 22+, instalarlo como el usuario final (sin sudo):\n    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n    . "$HOME/.nvm/nvm.sh" && nvm install 22\n    node --version                 # debe mostrar v22 o superior\n    ${npmInstallCommand}\n    wa setup                       # pregunta retención e imprime el QR en SSH\n    sudo loginctl enable-linger "$USER"  # una vez, para sobrevivir logout/reboot\n    wa doctor\n\nRetención: 7 días es el default privado. Elegir más días activa el pedido de full-history de Baileys con perfil desktop y conserva esa ventana localmente. WhatsApp decide cuánto historial entrega; una petición grande puede tardar, consumir disco o fallar durante el vínculo. Si ocurre, volver a 7 días con \`wa history-policy set 7\`, reiniciar el daemon y no borrar auth.\n\nEscanear el QR que el comando abre (macOS) o imprime en la terminal (SSH) desde WhatsApp móvil: Ajustes → Dispositivos vinculados → Vincular un dispositivo. Verificar con wa status hasta ver connection = open.\n\nNo ejecutar wa con sudo: el servicio y el estado privado pertenecen al usuario que vincula WhatsApp. No hace falta navegador. El bridge es un cliente vinculado de WhatsApp y conserva la sesión localmente.`,
    messages: `Lectura segura:\n  wa find "Nombre"\n  wa latest-incoming contacto --ids\n  wa history contacto 20 --ids\n  wa coverage contacto\n  wa delivery contacto <id>             # estado agregado de un chat directo\n  wa receipts grupo <id>                # receipts individuales reportados por WhatsApp\n  wa unread-by grupo <id>               # participantes sin read receipt reportado\n  wa reactions contacto-o-grupo <id>    # reacciones actuales al mensaje\n  wa links contacto                     # URLs literales recientes, con ID y cobertura\n  wa polls contacto / wa poll contacto <id>\n  wa calls contacto\n  wa group-events grupo\n\nEnvíos explícitos (send, reply y adjuntos): si la respuesta se pierde, repetir exactamente el comando recupera la confirmación original sin mandar un duplicado. Si informa que el envío anterior sigue sin confirmar, no reintentar a ciegas: verificar primero el chat o destinatario.\n\nlinks extrae únicamente URLs http(s) literales; no abre, resume ni clasifica sitios. La IA que invoca el CLI puede abrir cada URL con su herramienta web. latest incluye mensajes propios; latest-incoming sólo los recibidos. Para chats directos el CLI resuelve PN → LID actual antes de consultar. La ausencia de read receipt nunca se interpreta como que una persona no leyó el mensaje. Los mensajes view-once no se exponen ni se descargan.`,
    data: `Disponibilidad de datos (leer antes de sacar conclusiones):\n\nVentana y sincronización:\n  - El default local es 7 días; ver o cambiar la ventana con wa history-policy show|set <days|all>.\n  - Más de 7 días pide full-history a WhatsApp con perfil desktop. El proveedor decide cuánto entrega y puede limitarlo o fallar; no es un archivo garantizado.\n  - Usar wa coverage <contacto> antes de decir que “último” está actualizado.\n\nSe puede consultar de antes de instalar, sólo si WhatsApp lo incluyó en el sync y permanece dentro de la ventana configurada:\n  - texto, hora, remitente, citas, tipo de mensaje y adjuntos disponibles;\n  - el contenido actual de mensajes editados o efímeros que haya llegado en el sync;\n  - reacciones o receipts únicamente si llegaron dentro de ese mensaje sincronizado.\n\nNo se puede reconstruir retroactivamente:\n  - historial que WhatsApp no devolvió, ni el texto original de una edición;\n  - quién leyó, entregó o reaccionó antes de que el bridge recibiera ese dato;\n  - votos de encuestas anteriores si no se observó su clave y su actualización;\n  - cambios de grupo, llamadas perdidas, borrados y la secuencia histórica de eventos previos.\n\nDesde que el bridge está conectado y sano:\n  - entran mensajes nuevos, cambios de edición/borrado y adjuntos de la ventana;\n  - se guardan receipts, delivery, reacciones, votos de encuestas, llamadas y eventos de grupo que WhatsApp entregue;\n  - cada mensaje nuevo incluye preview factual de link, cita, menciones, forwarding y metadatos de media cuando WhatsApp los trae;\n  - estas señales siguen siendo reportes de WhatsApp, no prueba de intención humana.\n\nLímites que nunca se infieren:\n  - sin read receipt no significa “no lo vio” ni “me está ignorando”;\n  - receipts individuales de grupo aplican a mensajes propios;\n  - mensajes view-once no se exponen ni descargan;\n  - canales/newsletters, comunidades y estados no se espejan: sólo chats directos y grupos.\n\nComandos útiles: wa history-policy show, wa coverage <contacto>, wa history <contacto> 20 --ids, wa message <contacto> <id>.`,
    media: `Adjuntos:\n  wa audios contacto / wa audio contacto <message-id>\n  wa images contacto / wa image contacto <message-id>\n  wa videos contacto / wa video contacto <message-id>\n  wa stickers contacto / wa sticker contacto <message-id>\n  wa files contacto / wa file contacto <message-id>\n  wa send-image contacto /ruta/foto.jpg [caption]\n  wa send-video contacto /ruta/video.mp4 [caption]\n  wa send-audio contacto /ruta/audio.ogg [--voice]\n\nEl CLI descarga sólo el adjunto seleccionado y devuelve un path absoluto para que la IA lo abra con sus propias capacidades. La transcripción es opcional y local; nunca descarga un modelo sin aprobación explícita.`,
    daemon: `Servicio local:\n  wa daemon status\n  wa daemon restart\n  wa doctor\n\nEn macOS, setup instala un LaunchAgent. En Linux con systemd, instala un servicio de usuario. En ambos casos, mantenerlo activo permite recibir eventos nuevos. Un restart normal conserva auth y no necesita QR.\n\nEn un VPS Linux, habilitá linger una vez para que sobreviva al logout y reboot:\n  sudo loginctl enable-linger "$USER"\n\nNo ejecutar wa con sudo: el daemon debe correr con el mismo usuario que escaneó el QR.`,
    privacy: `Privacidad y límites:\n  - API sólo en 127.0.0.1.\n  - Retención default: 7 días; una ventana mayor requiere una elección explícita con wa history-policy.\n  - auth, SQLite, token y aliases no entran a Git ni Homebrew.\n  - No resetear auth ni pedir QR por un mensaje aparentemente viejo: usar doctor, status y coverage primero.`,
  }
  if (!topic) return usage()
  if (!topics[topic]) throw new Error(`Unknown help topic: ${topic}. Use: wa help setup|messages|data|media|daemon|privacy`)
  console.log(topics[topic])
}

function historyPolicyReport(policy, { configured = true } = {}) {
  return {
    configured,
    ...policy,
    providerRequest: policy.syncFullHistory
      ? 'Solicita full-history a WhatsApp con perfil desktop. WhatsApp puede entregar menos historial o rechazar/fallar el sync.'
      : 'Solicita sólo sync reciente de WhatsApp.',
    apply: 'Después de cambiarla, ejecutar `wa daemon restart` (o `wa setup` en una instalación nueva). No borra auth ni garantiza recuperar mensajes que WhatsApp no entregue.',
  }
}

async function hasHistoryPolicy() {
  return fileExists(historyPolicyPath(dataDir))
}

async function chooseHistoryPolicyForSetup() {
  if (await hasHistoryPolicy()) return loadHistoryPolicy(dataDir)
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.WA_NONINTERACTIVE === '1') {
    return saveHistoryPolicy(dataDir, DEFAULT_HISTORY_POLICY)
  }
  const { createInterface } = await import('node:readline/promises')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('\nHistorial local: el default es 7 días. Es privado y suficiente para contexto operativo reciente.')
    console.log('Podés elegir más días (por ejemplo 30, 90 o 365). Eso pide full-history a WhatsApp; puede tardar, usar más disco y WhatsApp puede entregar menos o fallar durante el vínculo.')
    const answer = (await prompt.question('¿Cuántos días querés conservar? [7]: ')).trim().toLocaleLowerCase()
    const requested = !answer ? 7 : answer === 'all' ? MAX_RETENTION_DAYS : answer
    const policy = historyPolicyForDays(requested)
    if (policy.syncFullHistory) console.log(`\nSe solicitará hasta ${policy.retentionDays} días. Si el QR/sync falla, usar: wa history-policy set 7`)
    return saveHistoryPolicy(dataDir, policy)
  } finally {
    prompt.close()
  }
}

async function historyPolicyCommand(args) {
  const action = args[0] || 'show'
  if (action === 'show') return console.log(JSON.stringify(historyPolicyReport(await loadHistoryPolicy(dataDir), { configured: await hasHistoryPolicy() }), null, 2))
  if (action !== 'set') return usage()
  const requested = args[1]?.toLocaleLowerCase()
  if (!requested) return usage()
  const policy = historyPolicyForDays(requested === 'all' ? MAX_RETENTION_DAYS : requested)
  await saveHistoryPolicy(dataDir, policy)
  console.log(JSON.stringify(historyPolicyReport(policy), null, 2))
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

async function installedBaileysVersion() {
  try {
    const { createRequire } = await import('node:module')
    return createRequire(path.join(projectRoot, 'package.json'))('baileys/package.json').version
  } catch {
    return null
  }
}

async function doctor() {
  let health = null
  try { health = await request('/health') } catch {}
  const daemon = process.platform === 'linux'
    ? { ...linuxServiceDiagnostics(), unitExists: await fileExists(systemdUnitPath) }
    : { type: 'launch-agent', label: launchAgentLabel, plistExists: await fileExists(launchAgentPath) }
  const nextStep = process.platform === 'linux' && daemon.userManager === null
      ? 'A systemd user manager is unavailable. Log in through systemd or run the bridge under the VPS supervisor.'
      : process.platform === 'linux' && daemon.linger === false
        ? `Run \`${lingerInstruction()}\` once so the bridge survives VPS logout and reboot, then run \`wa daemon restart\`.`
        : health?.connection === 'open'
          ? 'ready'
        : 'Run `wa setup` for first link, or `wa daemon restart` for an existing session.'
  console.log(JSON.stringify({
    stateRoot,
    version: packageInfo.version,
    baileysVersion: await installedBaileysVersion(),
    daemon,
    authExists: await fileExists(paths.authDir),
    sqliteExists: await fileExists(path.join(dataDir, 'mirror.sqlite')),
    qrPending: await fileExists(path.join(dataDir, 'link-qr.png')) || await fileExists(path.join(dataDir, 'link-qr.txt')),
    health,
    nextStep,
  }, null, 2))
}

async function setup() {
  await chooseHistoryPolicyForSetup()
  await installDaemon()
  const { qrPath, health } = await waitForSetup()
  if (qrPath) {
    await showQr()
  } else if (health?.connection === 'open') {
    console.log('WhatsApp Assistant is linked and ready. Try: wa status')
  } else {
    console.log(`The bridge is still starting. Run: wa qr\nIf no QR appears, run: wa doctor`)
  }
  if (process.platform === 'linux' && linuxServiceDiagnostics().linger === false) {
    console.log(`\nFor a VPS, make this persistent once:\n  ${lingerInstruction()}\nThen verify with: wa doctor`)
  }
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

async function splitMentions(args) {
  const values = []
  const mentionTargets = []
  while (args.length) {
    const value = args.shift()
    if (value !== '--mention') { values.push(value); continue }
    const mention = args.shift()
    if (!mention) throw new Error('Use --mention <contacto>')
    mentionTargets.push(mention)
  }
  const mentions = []
  for (const target of mentionTargets) mentions.push((await resolve(target)).jid)
  return { values, mentions }
}

function ensureMentionsAreForGroup(jid, mentions) {
  if (mentions.length && !jid.endsWith('@g.us')) throw new Error('Mentions are only supported when sending to a WhatsApp group.')
}

function extractOption(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const [, value] = args.splice(index, 2)
  if (!value) throw new Error(`Use ${name} <value>`)
  return value
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') return usage()
  if (command === '--version' || command === '-v' || command === 'version') return console.log(packageInfo.version)
  if (command === 'help') return help(args[0])
  if (command === '__daemon') return import('../src/server.js')
  if (command === 'doctor') return doctor()
  if (command === 'qr') return showQr()
  if (command === 'setup') return setup()
  if (command === 'history-policy') return historyPolicyCommand(args)
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
    const { chats, contactByPhone } = await recentChats(limit)
    const aliases = await loadAliases()
    const aliasByPhone = new Map(Object.values(aliases).map((item) => [item.phone, item.name || item.phone]))
    for (const chat of chats) {
      const phone = phoneFromJid(chat.jid)
      const name = aliasByPhone.get(phone) || chat.name || contactByPhone.get(phone) || 'sin nombre'
      console.log(`${formatTime(chat.lastTimestamp)} — ${name} (${phone || chat.jid})`)
    }
    return
  }
  if (command === 'groups') {
    const action = args.shift()
    if (action === 'participants') {
      const jid = args.shift()
      if (!jid || !jid.endsWith('@g.us')) throw new Error('Use: wa groups participants <group-jid>')
      const group = await whatsappGroup(jid)
      console.log(`Grupo: ${group.subject || jid}`)
      for (const participant of group.participants || []) console.log(`${participant.jid}${participant.admin ? ` — ${participant.admin}` : ''}`)
      return
    }
    if (!action || !['list', 'find', 'inspect', 'add'].includes(action)) return usage()
    if (action === 'inspect') {
      const jid = args.shift()
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '12', 10) || 12, 1), 50)
      if (!jid) return usage()
      const [groups, { messages: groupMessages }] = await Promise.all([whatsappGroups(), request(`/messages?jid=${encodeURIComponent(jid)}&limit=200`)])
      const group = groups.find((item) => item.jid === jid)
      if (!group) throw new Error(`Unknown WhatsApp group: ${jid}`)
      console.log(`Grupo: ${group.subject || 'sin título'} (${group.jid})`)
      if (group.desc) console.log(`Descripción: ${group.desc}`)
      const messages = groupMessages
        .filter((message) => message.text?.trim())
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
    const { values, mentions } = await splitMentions(args)
    const text = values.join(' ').trim()
    if (!target || !text) return usage()
    const contact = await resolve(target)
    ensureMentionsAreForGroup(contact.jid, mentions)
    const result = await sendOnce(
      { kind: 'text', to: outboundDestination(contact), text, mentions, replyToMessageId: null },
      (requestId) => sendMessage(contact.jid, text, null, mentions, requestId),
    )
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}${result.replayed ? ' (confirmed from an earlier request)' : ''}.`)
  }
  if (command === 'reply') {
    const target = args.shift()
    const selector = args.shift()
    const text = args.join(' ').trim()
    if (!target || !selector || !text) return usage()
    const contact = await resolve(target)
    const quoted = await resolveMessageSelector(contact, selector)
    const result = await sendOnce(
      { kind: 'reply', to: outboundDestination(contact), text, mentions: [], replyToMessageId: quoted.id },
      (requestId) => sendMessage(contact.jid, text, quoted.id, [], requestId),
    )
    return console.log(`Reply sent${result.id ? ` (${result.id})` : ''}${result.replayed ? ' (confirmed from an earlier request)' : ''}.`)
  }
  if (command === 'send-file') {
    const target = args.shift()
    const filePath = args.shift()
    if (!target || !filePath) return usage()
    const replySelector = extractOption(args, '--reply-to')
    const caption = args.join(' ').trim()
    const file = path.resolve(filePath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
    const contact = await resolve(target)
    const replyTo = replySelector ? (await resolveMessageSelector(contact, replySelector)).id : null
    const result = await sendOnce(
      { kind: 'document', to: outboundDestination(contact), file: { path: file, size: stat.size, modifiedAt: stat.mtimeMs }, caption, replyToMessageId: replyTo },
      (requestId) => sendFile(contact.jid, file, caption, replyTo, requestId),
    )
    return console.log(`Sent${result.id ? ` (${result.id})` : ''}${result.replayed ? ' (confirmed from an earlier request)' : ''}.`)
  }
  if (command === 'send-image' || command === 'send-video' || command === 'send-audio') {
    const target = args.shift()
    const filePath = args.shift()
    if (!target || !filePath) return usage()
    const replySelector = extractOption(args, '--reply-to')
    const { values, mentions } = await splitMentions(args)
    const voiceIndex = values.indexOf('--voice')
    const voice = voiceIndex >= 0
    if (voiceIndex >= 0) values.splice(voiceIndex, 1)
    if (voice && command !== 'send-audio') throw new Error('--voice is only valid with wa send-audio')
    const file = path.resolve(filePath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
    const contact = await resolve(target)
    ensureMentionsAreForGroup(contact.jid, mentions)
    const replyTo = replySelector ? (await resolveMessageSelector(contact, replySelector)).id : null
    const kind = command.replace('send-', '')
    const caption = values.join(' ').trim()
    const result = await sendOnce(
      { kind, to: outboundDestination(contact), file: { path: file, size: stat.size, modifiedAt: stat.mtimeMs }, caption, mentions, voice, replyToMessageId: replyTo },
      (requestId) => sendMedia(contact.jid, kind, file, caption, mentions, voice, replyTo, requestId),
    )
    return console.log(`Sent ${kind}${result.id ? ` (${result.id})` : ''}${result.replayed ? ' (confirmed from an earlier request)' : ''}.`)
  }
  if (command === 'edit') {
    const target = args.shift()
    const messageId = args.shift()
    const text = args.join(' ').trim()
    if (!target || !messageId || !text) return usage()
    const contact = await resolve(target)
    const message = await resolveMessageSelector(contact, messageId, { ownOnly: true })
    await editMessage(contact.jid, message.id, text)
    return console.log(`Edited (${message.id}).`)
  }
  if (command === 'unsend') {
    const target = args.shift()
    const selector = args.shift()
    if (!target || !selector) return usage()
    const contact = await resolve(target)
    const message = await resolveMessageSelector(contact, selector, { ownOnly: true })
    await revokeMessage(contact.jid, message.id)
    return console.log(`Unsent (${message.id}).`)
  }
  if (command === 'mark-read') {
    const target = args.shift()
    const selector = args.shift()
    if (!target || !selector) return usage()
    const contact = await resolve(target)
    const message = await resolveMessageSelector(contact, selector, { incomingOnly: true })
    await markMessageRead(contact.jid, message.id)
    return console.log(`Marked as read (${message.id}).`)
  }
  if (command === 'search-all') {
    const query = args.shift()?.trim()
    if (!query) return usage()
    let sinceSeconds = null
    let scope = 'all'
    let groupList = null
    let ids = false
    while (args.length) {
      const option = args.shift()
      if (option === '--since') sinceSeconds = parseSince(args.shift())
      else if (option === '--direct') scope = 'direct'
      else if (option === '--groups') { scope = 'groups'; groupList = args.shift() || null }
      else if (option === '--ids') ids = true
      else throw new Error(`Unknown option: ${option}`)
    }
    const allowedGroups = groupList ? ((await loadGroupLists()).lists[groupList]?.groups?.map((group) => group.jid) || []) : null
    const parameters = new URLSearchParams({ q: query, limit: '100' })
    if (sinceSeconds) parameters.set('since', String(sinceSeconds))
    if (scope !== 'all') parameters.set('scope', scope)
    if (allowedGroups?.length) parameters.set('jids', allowedGroups.join(','))
    const [{ messages: matches }, identities] = await Promise.all([
      request(`/search?${parameters.toString()}`),
      readIdentities(),
    ])
    const cache = { chats: Object.fromEntries(identities.chats.map((chat) => [chat.jid, chat])), contacts: identities.contacts }
    return printMessages(matches, { ids, cache, empty: 'Sin coincidencias en la ventana local retenida.' })
  }
  if (command === 'latest' || command === 'latest-incoming' || command === 'coverage' || command === 'history' || command === 'search' || command === 'transcribe' || command === 'audios' || command === 'audio' || command === 'images' || command === 'image' || command === 'videos' || command === 'video' || command === 'stickers' || command === 'sticker' || command === 'files' || command === 'file' || command === 'locations' || command === 'contacts' || command === 'polls' || command === 'poll' || command === 'calls' || command === 'links' || command === 'group-events' || command === 'message' || command === 'delivery' || command === 'receipts' || command === 'unread-by' || command === 'reactions' || command === 'react') {
    const target = args.shift()
    if (!target) return usage()
    const contact = await resolve(target)
    const { messages } = await request(`/messages?jid=${encodeURIComponent(contact.jid)}&limit=200`)
    const identities = ['polls', 'poll', 'receipts', 'unread-by', 'reactions'].includes(command) ? await readIdentities() : null
    if (command === 'coverage') {
      const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
      console.log(JSON.stringify({ chat: contact.name || target, ...coverage }, null, 2))
      return
    }
    if (command === 'latest' || command === 'latest-incoming') {
      await requireFreshCoverage(contact)
      const latest = command === 'latest-incoming' ? messages.find((message) => !message.fromMe) : messages[0]
      if (!latest) return console.log(command === 'latest-incoming' ? 'No hay mensajes entrantes cacheados para este chat.' : 'No hay mensajes cacheados para este chat.')
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
    if (command === 'videos' || command === 'video') {
      const videos = messages.filter((message) => message.type === 'videoMessage')
      if (command === 'videos') {
        const shown = videos.slice(0, Number.parseInt(args[0] || '20', 10))
        if (!shown.length) return console.log('No hay videos cacheados para este chat.')
        for (const video of shown) console.log(`${formatTime(video.timestamp)} — ${video.id} (${video.videoRef ? 'disponible' : 'sin captura local'})${video.text ? ` — ${video.text.slice(0, 500)}` : ''}`)
        return
      }
      const messageId = args.shift()
      if (!messageId) return usage()
      const { video } = await downloadVideo(contact.jid, messageId)
      return console.log(video.path)
    }
    if (command === 'stickers' || command === 'sticker') {
      const stickers = messages.filter((message) => message.type === 'stickerMessage')
      if (command === 'stickers') {
        const shown = stickers.slice(0, Number.parseInt(args[0] || '20', 10))
        if (!shown.length) return console.log('No hay stickers cacheados para este chat.')
        for (const sticker of shown) console.log(`${formatTime(sticker.timestamp)} — ${sticker.id} (${sticker.stickerRef ? 'disponible' : 'sin captura local'})`)
        return
      }
      const messageId = args.shift()
      if (!messageId) return usage()
      const { sticker } = await downloadSticker(contact.jid, messageId)
      return console.log(sticker.path)
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
    if (command === 'links') {
      const limit = Math.min(Math.max(Number.parseInt(args[0] || '20', 10) || 20, 1), 50)
      const coverage = await request(`/coverage?jid=${encodeURIComponent(contact.jid)}`)
      const links = messages.flatMap((message) => linksForMessage(message).map((url) => ({
        messageId: message.id,
        timestamp: message.timestamp,
        fromMe: message.fromMe,
        participant: message.participant,
        pushName: message.pushName,
        url,
      }))).slice(0, limit)
      if (!links.length) return console.log('No hay URLs http(s) cacheadas para este chat.')
      return console.log(JSON.stringify({
        chat: contact.name || target,
        coverage,
        links,
        note: 'URLs extraídas literalmente del contenido cacheado. El CLI no abre, resume ni clasifica destinos; usar la herramienta web de la IA para inspeccionarlos.',
      }, null, 2))
    }
    if (command === 'locations' || command === 'contacts' || command === 'polls' || command === 'calls') {
      if (command === 'calls') {
        const limit = Number.parseInt(args[0] || '20', 10)
        const { events } = await request(`/events?kind=call&jid=${encodeURIComponent(contact.jid)}&limit=${limit}`)
        const missedMessages = messages.filter((message) => message.call).slice(0, limit).map((message) => ({ id: message.id, timestamp: message.timestamp, fromMe: message.fromMe, call: message.call }))
        if (!events.length && !missedMessages.length) return console.log('No hay llamadas cacheadas para este chat.')
        return console.log(JSON.stringify({ events, missedCallMessages: missedMessages, note: 'Los eventos de llamada se conservan sólo desde que el bridge estaba activo; WhatsApp puede además generar un mensaje de llamada perdida.' }, null, 2))
      }
      const field = command === 'locations' ? 'location' : command === 'contacts' ? 'contacts' : 'poll'
      const selected = messages.filter((message) => field === 'contacts' ? message.contacts?.length : Boolean(message[field])).slice(0, Number.parseInt(args[0] || '20', 10))
      if (!selected.length) return console.log(`No hay ${command} cacheados para este chat.`)
      return console.log(JSON.stringify(selected.map((message) => command === 'polls' ? pollReport(message, identities.contacts) : ({ id: message.id, timestamp: message.timestamp, fromMe: message.fromMe, [field]: message[field] })), null, 2))
    }
    if (command === 'group-events') {
      if (!contact.jid.endsWith('@g.us')) throw new Error('group-events is only available for WhatsApp groups.')
      const limit = Number.parseInt(args[0] || '20', 10)
      const [{ events }, eventIdentities] = await Promise.all([
        request(`/events?kind=group&jid=${encodeURIComponent(contact.jid)}&limit=${limit}`),
        readIdentities(),
      ])
      if (!events.length) return console.log('No hay cambios de grupo cacheados para este grupo.')
      return console.log(JSON.stringify(events.map((event) => ({ ...event, participant: event.participant ? contactIdentity(event.participant, eventIdentities.contacts) : null, author: event.author ? contactIdentity(event.author, eventIdentities.contacts) : null })), null, 2))
    }
    if (command === 'message' || command === 'delivery' || command === 'receipts' || command === 'unread-by' || command === 'reactions' || command === 'poll') {
      const messageId = args.shift()
      if (!messageId) return usage()
      const message = messages.find((item) => item.id === messageId)
      if (!message) throw new Error(`No matching message found: ${messageId}`)
      if (command === 'delivery') return console.log(JSON.stringify({ id: message.id, fromMe: message.fromMe, status: message.status, statusAt: message.statusAt }, null, 2))
      if (command === 'reactions') return console.log(JSON.stringify({ id: message.id, fromMe: message.fromMe, reactions: (message.reactions || []).map((reaction) => ({ ...reaction, participant: contactIdentity(reaction.participant, identities.contacts) })) }, null, 2))
      if (command === 'poll') {
        if (!message.poll) throw new Error('This message is not a poll.')
        return console.log(JSON.stringify(pollReport(message, identities.contacts), null, 2))
      }
      if (command === 'receipts' || command === 'unread-by') {
        if (!contact.jid.endsWith('@g.us')) {
          if (command === 'unread-by') throw new Error('unread-by is only available for WhatsApp groups.')
          return console.log(JSON.stringify({ id: message.id, fromMe: message.fromMe, status: message.status, statusAt: message.statusAt, note: 'Los chats directos sólo exponen el estado agregado que reporta WhatsApp.' }, null, 2))
        }
        if (!message.fromMe) throw new Error(`${command} is only available for a message sent by this account.`)
        const report = groupReceiptReport(message, await whatsappGroup(contact.jid), identities.contacts)
        if (command === 'unread-by') return console.log(JSON.stringify({ message: report.message, participantCount: report.participantCount, withoutReportedReadReceipt: report.withoutReportedReadReceipt, note: report.note }, null, 2))
        return console.log(JSON.stringify(report, null, 2))
      }
      return console.log(JSON.stringify({ ...message, links: linksForMessage(message) }, null, 2))
    }
    if (command === 'react') {
      const selector = args.shift(); const emoji = args.shift()
      if (!selector || !emoji) return usage()
      const message = await resolveMessageSelector(contact, selector)
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
