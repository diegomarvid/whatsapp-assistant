import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { launchAgentLabel, launchAgentPlist } from '../src/launch-agent.js'
import { runtimePaths } from '../src/runtime-paths.js'

test('keeps development state beside the checked-out project', () => {
  const root = '/work/whatsapp-assistant'
  const result = runtimePaths({ root, home: '/Users/example', platform: 'darwin', env: {} })
  assert.equal(result.stateRoot, root)
  assert.equal(result.authDir, path.join(root, 'auth'))
  assert.equal(result.dataDir, path.join(root, 'data'))
})

test('uses private macOS application support state for a packaged install', () => {
  const result = runtimePaths({ root: '/opt/homebrew/lib/node_modules/whatsapp-assistant', home: '/Users/example', platform: 'darwin', env: {} })
  assert.equal(result.stateRoot, '/Users/example/Library/Application Support/WhatsApp Assistant')
  assert.equal(result.authDir, '/Users/example/Library/Application Support/WhatsApp Assistant/auth')
})

test('honors an explicit state directory on every platform', () => {
  const result = runtimePaths({ root: '/opt/homebrew/lib/node_modules/whatsapp-assistant', home: '/Users/example', platform: 'linux', env: { WA_STATE_DIR: '/private/wa-state' } })
  assert.equal(result.stateRoot, '/private/wa-state')
  assert.equal(result.dataDir, '/private/wa-state/data')
})

test('renders a private launch agent that pins state outside the package', () => {
  const plist = launchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    serverPath: '/opt/homebrew/lib/node_modules/whatsapp-assistant/src/server.js',
    stateRoot: '/Users/example/Library/Application Support/WhatsApp Assistant',
    logsDir: '/Users/example/Library/Application Support/WhatsApp Assistant/logs',
  })
  assert.match(plist, new RegExp(`<string>${launchAgentLabel}</string>`))
  assert.match(plist, /<key>WA_STATE_DIR<\/key>/)
  assert.match(plist, /Application Support\/WhatsApp Assistant\/logs\/bridge\.log/)
  assert.doesNotMatch(plist, /auth\//)
})
