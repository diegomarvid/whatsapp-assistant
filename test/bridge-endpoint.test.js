import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BRIDGE_PORT, bridgeBaseUrl, bridgePort } from '../src/bridge-endpoint.js'
import { launchAgentPlist } from '../src/launch-agent.js'
import { systemdUserUnit } from '../src/systemd-service.js'

test('the CLI and the bridge agree on a loopback endpoint', () => {
  assert.equal(bridgePort({}), DEFAULT_BRIDGE_PORT)
  assert.equal(bridgePort({ WA_BRIDGE_PORT: '4111' }), 4111)
  assert.equal(bridgePort({ WA_BRIDGE_PORT: 'nope' }), DEFAULT_BRIDGE_PORT)
  assert.equal(bridgePort({ WA_BRIDGE_PORT: '0' }), DEFAULT_BRIDGE_PORT)
  assert.equal(bridgeBaseUrl({ WA_BRIDGE_PORT: '4111' }), 'http://127.0.0.1:4111')
  assert.equal(bridgeBaseUrl({}), `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`)
})

test('daemon templates pin a chosen bridge port so restarts keep the same endpoint', () => {
  const base = { nodePath: '/usr/bin/node', stateRoot: '/home/u/state', logsDir: '/home/u/state/logs' }
  const plist = launchAgentPlist({ ...base, serverPath: '/pkg/src/server.js', bridgePort: '4111' })
  assert.match(plist, /<key>WA_BRIDGE_PORT<\/key><string>4111<\/string>/)
  const plistWithoutPort = launchAgentPlist({ ...base, serverPath: '/pkg/src/server.js' })
  assert.doesNotMatch(plistWithoutPort, /WA_BRIDGE_PORT/)

  const unit = systemdUserUnit({ ...base, entryPath: '/pkg/bin/wa.js', entryArguments: ['__daemon'], bridgePort: '4111' })
  assert.match(unit, /Environment="WA_BRIDGE_PORT=4111"/)
  const unitWithoutPort = systemdUserUnit({ ...base, entryPath: '/pkg/bin/wa.js', entryArguments: ['__daemon'] })
  assert.doesNotMatch(unitWithoutPort, /WA_BRIDGE_PORT/)
  assert.match(unitWithoutPort, /Environment="WA_STATE_DIR=\/home\/u\/state"\nEnvironment="PATH=/)
})
