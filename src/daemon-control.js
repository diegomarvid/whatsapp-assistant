import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run, tryRun } from './exec.js'
import { launchAgentLabel, launchAgentPlist } from './launch-agent.js'
import { paths, projectRoot } from './runtime-paths.js'
import { ensureRuntimeDirectories, fileExists } from './state-dirs.js'
import { systemdServiceName, systemdUserUnit, systemdUserUnitPath } from './systemd-service.js'

const { stateRoot, logsDir } = paths
export const launchAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`)
export const systemdUnitPath = systemdUserUnitPath({ home: os.homedir() })

function launchctlDomain() {
  return `gui/${process.getuid()}`
}

export function linuxServiceDiagnostics() {
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

function assertSetupPrerequisites() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) throw new Error(`WhatsApp Assistant requires Node.js 22 or newer; found ${process.version}. Install Node 22+, open a new shell, then rerun \`wa setup\`.`)
  if (process.platform !== 'linux') return
  const manager = tryRun('systemctl', ['--user', 'show-environment'])
  if (manager.status !== 0) {
    throw new Error('A systemd user manager is required for VPS persistence. Log in as the final non-root user (do not run `wa` with sudo), then run `systemctl --user status` and retry `wa setup`. On a system without systemd, run the bridge with your own supervisor.')
  }
}

export function lingerInstruction() {
  return `sudo loginctl enable-linger "${os.userInfo().username}"`
}

export function daemonDisplayName() {
  return process.platform === 'linux' ? systemdServiceName : launchAgentLabel
}

export async function installDaemon() {
  assertSetupPrerequisites()
  await ensureRuntimeDirectories()
  const serverPath = path.join(projectRoot, 'src', 'server.js')
  const entryPath = process.env.WA_DAEMON_ENTRY || serverPath
  const entryArguments = process.env.WA_DAEMON_ENTRY ? ['__daemon'] : []
  const nodePath = process.env.WA_DAEMON_NODE || process.execPath
  const workingDirectory = process.env.WA_DAEMON_CWD || path.dirname(serverPath)
  const bridgePort = process.env.WA_BRIDGE_PORT || null
  if (process.platform === 'linux') {
    await fs.mkdir(path.dirname(systemdUnitPath), { recursive: true, mode: 0o700 })
    const unit = systemdUserUnit({ nodePath, entryPath, entryArguments, stateRoot, logsDir, workingDirectory, bridgePort })
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
    bridgePort,
  })
  await fs.writeFile(launchAgentPath, plist, { mode: 0o600 })
  tryRun('launchctl', ['bootout', launchctlDomain(), launchAgentPath])
  run('launchctl', ['bootstrap', launchctlDomain(), launchAgentPath])
}

export async function daemonStatus() {
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

export async function restartDaemon() {
  if (process.platform === 'linux') {
    if (!await fileExists(systemdUnitPath)) return installDaemon()
    run('systemctl', ['--user', 'restart', systemdServiceName])
    return
  }
  if (process.platform !== 'darwin') throw new Error(`No managed daemon is available for ${process.platform}.`)
  if (!await fileExists(launchAgentPath)) return installDaemon()
  run('launchctl', ['kickstart', '-k', `${launchctlDomain()}/${launchAgentLabel}`])
}

export async function uninstallDaemon() {
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
