import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'wa.js')

test('help gives a new user and an AI an actionable onboarding path', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /brew install whatsapp-assistant/)
  assert.match(result.stdout, /Linux \/ VPS/)
  assert.match(result.stdout, /loginctl enable-linger/)
  assert.match(result.stdout, /nvm install 22/)
  assert.match(result.stdout, /wa setup/)
  assert.match(result.stdout, /wa doctor/)
  assert.match(result.stdout, /latest-incoming/)
  assert.match(result.stdout, /wa image <alias or phone> <message-id>/)
  assert.doesNotMatch(result.stdout, /image-text/)
})

test('setup help explains the QR flow without needing a running bridge', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'setup'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Dispositivos vinculados/)
  assert.match(result.stdout, /connection = open/)
  assert.match(result.stdout, /Node 22/)
  assert.match(result.stdout, /nvm install 22/)
  assert.match(result.stdout, /No ejecutar wa con sudo/)
})

test('data help distinguishes recent synced facts from live observed events', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'data'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /antes de instalar/)
  assert.match(result.stdout, /No se puede reconstruir retroactivamente/)
  assert.match(result.stdout, /Desde que el bridge está conectado y sano/)
  assert.match(result.stdout, /sin read receipt no significa/)
  assert.match(result.stdout, /view-once no se exponen/)
})

test('transcription doctor identifies an incomplete private runtime instead of calling it ready', () => {
  const result = spawnSync(process.execPath, [cli, 'transcribe', 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, WA_STATE_DIR: path.join('/tmp', `wa-transcribe-doctor-${process.pid}`) },
  })
  assert.equal(result.status, 0)
  const doctor = JSON.parse(result.stdout)
  assert.equal(doctor.runtimeInstalled, false)
  assert.match(doctor.nextStep, /Run `wa transcribe`/)
})
