import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentProfiles } from '../src/agent-providers.js'
import { PromptAutomationRules } from '../src/prompt-automation-rules.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'wa.js')

test('verbose automation list joins each rule with its provider profile without printing prompt contents', async (context) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-automation-verbose-'))
  context.after(() => fs.rm(stateRoot, { recursive: true, force: true }))
  const promptPath = path.join(stateRoot, 'ines.md')
  await fs.writeFile(promptPath, 'Private task instructions.\n', { mode: 0o600 })
  const dataDir = path.join(stateRoot, 'data')
  const profiles = new AgentProfiles(path.join(dataDir, 'agent-profiles.json'))
  const profile = await profiles.set({ name: 'ines-opus', provider: 'claude', model: 'opus', effort: 'medium', promptFile: promptPath, workspace: stateRoot, timeoutMs: 90000 })
  const automations = new PromptAutomationRules(path.join(dataDir, 'prompt-automations.json'))
  await automations.add({
    name: 'ines-platform', source: 'Inés', sourceTarget: 'ines-nelcor', sourceJid: 'ines@lid', sourceOriginalJid: '59894070759@s.whatsapp.net',
    destination: 'Inés', destinationTarget: 'ines-nelcor', destinationJid: 'ines@lid', destinationOriginalJid: '59894070759@s.whatsapp.net',
    profile: 'ines-opus', direction: 'incoming', debounceSeconds: 300,
  })

  const result = spawnSync(process.execPath, [cli, 'automation', 'prompt', 'list', '--verbose'], {
    encoding: 'utf8', env: { ...process.env, WA_STATE_DIR: stateRoot },
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /ines-platform — active/)
  assert.match(result.stdout, /IA: claude\/opus; effort medium/)
  assert.match(result.stdout, new RegExp(`Prompt: ${profile.prompt.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(result.stdout, /Workspace: .*wa-automation-verbose/)
  assert.match(result.stdout, /Timeout: 90000 ms/)
  assert.doesNotMatch(result.stdout, /Private task instructions/)
})
