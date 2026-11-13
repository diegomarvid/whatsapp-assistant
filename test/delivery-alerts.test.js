import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { alertPayload, DeliveryAlerts } from '../src/delivery-alerts.js'
import { linkAlertMessage } from '../src/link-health.js'

const failed = {
  id: 'abcdef0123456789abcdef0123456789', target: 'Ana', status: 'failed', failureCode: 'no_recipient_devices',
  lastError: 'WhatsApp returned no device for x@lid; nothing was sent.', dueAt: '2026-11-02T12:00:00.000Z', attempts: 3,
  text: 'PRIVATE MESSAGE TEXT',
}

async function alertsFor(context, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-alerts-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const calls = []
  const alerts = new DeliveryAlerts(path.join(directory, 'delivery-alerts.json'), { run: async (command, runOptions) => { calls.push({ command, ...runOptions }) }, ...options })
  return { alerts, calls }
}

test('a configured command gets a summary argument and a JSON payload, never the message text', async (context) => {
  const { alerts, calls } = await alertsFor(context, { platform: 'linux' })
  await alerts.save(['/usr/local/bin/notify', 'telegram'])
  assert.equal(await alerts.notify(failed), 'command')
  const [call] = calls
  assert.deepEqual(call.command.slice(0, 2), ['/usr/local/bin/notify', 'telegram'])
  assert.match(call.command[2], /mensaje programado abcdef01 para Ana quedó failed\..*wa schedule show abcdef0123456789abcdef0123456789/)
  assert.deepEqual(JSON.parse(call.input), alertPayload(failed))
  assert.doesNotMatch(JSON.stringify(call), /PRIVATE MESSAGE TEXT/)
})

test('without a command, macOS shows a local notification and other platforms only log', async (context) => {
  const mac = await alertsFor(context, { platform: 'darwin' })
  assert.equal(await mac.alerts.notify({ ...failed, target: 'Ana "quoted"' }), 'macos')
  assert.equal(mac.calls[0].command[0], '/usr/bin/osascript')
  assert.match(mac.calls[0].command[2], /^display notification ".*Ana \\"quoted\\".*" with title "WhatsApp Assistant"$/)
  const linux = await alertsFor(context, { platform: 'linux' })
  assert.equal(await linux.alerts.notify(failed), 'none')
  assert.equal(linux.calls.length, 0)
})

test('the alert command must be an absolute executable with shell-free arguments', async (context) => {
  const { alerts } = await alertsFor(context, { platform: 'linux' })
  await assert.rejects(alerts.save(['notify']), /absolute executable/)
  await assert.rejects(alerts.save([]), /absolute executable/)
  await alerts.save(['/bin/echo'])
  await alerts.clear()
  assert.equal(await alerts.load(), null)
})

test('a link-health alert goes through the same configured channel', async (context) => {
  const { alerts, calls } = await alertsFor(context, { platform: 'darwin' })
  await alerts.save(['/usr/local/bin/notify', 'telegram'])
  const alert = linkAlertMessage('opened', { openedAt: 1794538007 }, { reasons: ['offline_queue_not_flushed'], offlineQueue: { pendingSince: 1794516679 }, streamErrors: { unackedLast3h: 0 } }, 1794538007)
  assert.equal(await alerts.notifyLink(alert), 'command')
  assert.deepEqual(calls[0].command, ['/usr/local/bin/notify', 'telegram', alert.summary])
  assert.deepEqual(JSON.parse(calls[0].input), alert.payload)
})
