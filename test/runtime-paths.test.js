import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { launchAgentLabel, launchAgentPlist } from '../src/launch-agent.js'
import { runtimePaths } from '../src/runtime-paths.js'
import { systemdServiceName, systemdUserUnit, systemdUserUnitPath } from '../src/systemd-service.js'
import { DEFAULT_FASTER_MODEL, DEFAULT_MLX_MODEL, cachedModelSnapshot, defaultModelFor, huggingFaceHubPath, selectLocalModel, transcriptionBackend } from '../src/transcription-runtime.js'

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

test('uses XDG private state for a packaged Linux install', () => {
  const result = runtimePaths({ root: '/usr/lib/node_modules/whatsapp-assistant', home: '/home/example', platform: 'linux', env: {} })
  assert.equal(result.stateRoot, '/home/example/.local/state/whatsapp-assistant')
  assert.equal(result.authDir, '/home/example/.local/state/whatsapp-assistant/auth')
})

test('ignores relative XDG state paths', () => {
  const result = runtimePaths({ root: '/usr/lib/node_modules/whatsapp-assistant', home: '/home/example', platform: 'linux', env: { XDG_STATE_HOME: 'relative-state' } })
  assert.equal(result.stateRoot, '/home/example/.local/state/whatsapp-assistant')
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
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/opt\/homebrew\/lib\/node_modules\/whatsapp-assistant\/src<\/string>/)
  assert.doesNotMatch(plist, /auth\//)
})

test('supports a stable CLI entry point for package-manager upgrades', () => {
  const plist = launchAgentPlist({
    nodePath: '/opt/homebrew/opt/node@24/bin/node',
    serverPath: '/opt/homebrew/Cellar/whatsapp-assistant/0.2.2/libexec/lib/node_modules/whatsapp-assistant/src/server.js',
    entryPath: '/opt/homebrew/opt/whatsapp-assistant/libexec/lib/node_modules/whatsapp-assistant/bin/wa.js',
    entryArguments: ['__daemon'],
    workingDirectory: '/opt/homebrew/opt/whatsapp-assistant/libexec/lib/node_modules/whatsapp-assistant/src',
    stateRoot: '/Users/example/Library/Application Support/WhatsApp Assistant',
    logsDir: '/Users/example/Library/Application Support/WhatsApp Assistant/logs',
  })
  assert.match(plist, /opt\/whatsapp-assistant\/libexec\/lib\/node_modules\/whatsapp-assistant\/bin\/wa\.js/)
  assert.match(plist, /<string>__daemon<\/string>/)
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/opt\/homebrew\/opt\/whatsapp-assistant\/libexec\/lib\/node_modules\/whatsapp-assistant\/src<\/string>/)
})

test('renders a user-level systemd unit with private state outside the package', () => {
  const unitPath = systemdUserUnitPath({ home: '/home/example', env: {} })
  assert.equal(unitPath, `/home/example/.config/systemd/user/${systemdServiceName}`)
  const unit = systemdUserUnit({
    nodePath: '/usr/bin/node',
    entryPath: '/usr/lib/node_modules/whatsapp-assistant/bin/wa.js',
    entryArguments: ['__daemon'],
    stateRoot: '/home/example/.local/state/whatsapp-assistant',
    logsDir: '/home/example/.local/state/whatsapp-assistant/logs',
    workingDirectory: '/usr/lib/node_modules/whatsapp-assistant/src',
  })
  assert.match(unit, new RegExp(`Description=WhatsApp Assistant local bridge`))
  assert.match(unit, /Environment="WA_STATE_DIR=\/home\/example\/\.local\/state\/whatsapp-assistant"/)
  assert.match(unit, /WorkingDirectory=\/usr\/lib\/node_modules\/whatsapp-assistant\/src/)
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/usr\/lib\/node_modules\/whatsapp-assistant\/bin\/wa\.js" "__daemon"/)
  assert.match(unit, /Restart=always/)
  assert.match(unit, /WantedBy=default.target/)
  assert.doesNotMatch(unit, /auth\//)
})

test('ignores relative XDG config paths for a systemd user unit', () => {
  const unitPath = systemdUserUnitPath({ home: '/home/example', env: { XDG_CONFIG_HOME: 'relative-config' } })
  assert.equal(unitPath, `/home/example/.config/systemd/user/${systemdServiceName}`)
})

test('selects a platform-compatible local transcription backend and model cache', () => {
  assert.equal(transcriptionBackend({ platform: 'darwin', arch: 'arm64' }), 'mlx')
  assert.equal(transcriptionBackend({ platform: 'linux', arch: 'x64' }), 'faster-whisper')
  assert.equal(defaultModelFor('mlx'), DEFAULT_MLX_MODEL)
  assert.equal(defaultModelFor('faster-whisper'), DEFAULT_FASTER_MODEL)
  const root = path.join('/tmp', `whatsapp-assistant-test-${process.pid}`)
  const model = DEFAULT_MLX_MODEL
  const snapshot = path.join(root, 'hub', `models--${model.replace('/', '--')}`, 'snapshots', 'revision')
  fs.mkdirSync(snapshot, { recursive: true })
  fs.mkdirSync(path.join(root, 'hub', `models--${model.replace('/', '--')}`, 'refs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hub', `models--${model.replace('/', '--')}`, 'refs', 'main'), 'revision\n')
  const env = { HF_HOME: root }
  assert.equal(huggingFaceHubPath({ env, home: '/home/example' }), path.join(root, 'hub'))
  assert.equal(cachedModelSnapshot(model, { env, home: '/home/example' }), snapshot)
  assert.deepEqual(selectLocalModel({ backend: 'mlx', env, home: '/home/example' }), { model, path: snapshot, source: 'default-cache' })
  fs.rmSync(root, { recursive: true, force: true })
})
