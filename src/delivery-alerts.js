import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runAdapterCommand } from './review-adapter.js'
import { scheduledStatusLabel } from './scheduled-messages.js'

// Owner-facing alert when a scheduled message did not go out (failed,
// uncertain or expired). An explicitly configured command receives a one-line
// summary as its last argument and a JSON payload on stdin; without one, macOS
// shows a local notification. The alert never contains the message text: the
// owner reads it with `wa schedule show <id>`.
export function validateAlertCommand(command) {
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part || part.includes('\0')) || !path.isAbsolute(command[0])) {
    throw new Error('The alert command must start with an absolute executable path (arguments are passed without a shell).')
  }
  return command
}

export function alertSummary(message) {
  const status = scheduledStatusLabel(message)
  const reason = message.lastError ? ` ${message.lastError}` : ''
  return `WhatsApp Assistant: el mensaje programado ${message.id.slice(0, 8)} para ${message.target} quedó ${status}.${reason} Ver: wa schedule show ${message.id}`
}

export function alertPayload(message) {
  return {
    version: 1,
    kind: 'scheduled_message',
    id: message.id,
    status: message.status,
    code: message.failureCode || null,
    reason: message.lastError || null,
    target: message.target,
    dueAt: message.dueAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt || null,
  }
}

function appleScriptString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
}

export class DeliveryAlerts {
  constructor(filename, { platform = process.platform, run = runAdapterCommand } = {}) {
    this.filename = filename
    this.platform = platform
    this.run = run
  }

  async load() {
    try {
      const config = JSON.parse(await fs.readFile(this.filename, 'utf8'))
      if (config?.version !== 1) throw new Error('Unsupported delivery alert configuration.')
      return { version: 1, command: validateAlertCommand(config.command) }
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async save(command) {
    validateAlertCommand(command)
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, command }, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, this.filename)
    return { version: 1, command }
  }

  async clear() {
    await fs.rm(this.filename, { force: true })
  }

  // Resolves to the channel used ('command', 'macos' or 'none'); rejects when
  // the configured channel failed, so the caller can log it.
  async notify(message) {
    const summary = alertSummary(message)
    const config = await this.load()
    if (config) {
      await this.run([...config.command, summary], { input: `${JSON.stringify(alertPayload(message))}\n`, timeoutMs: 30_000 })
      return 'command'
    }
    if (this.platform === 'darwin') {
      await this.run(['/usr/bin/osascript', '-e', `display notification ${appleScriptString(summary)} with title "WhatsApp Assistant"`], { timeoutMs: 15_000 })
      return 'macos'
    }
    return 'none'
  }
}
