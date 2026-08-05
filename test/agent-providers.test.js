import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildAutomationProviderInvocation, buildProviderInvocation } from '../src/agent-provider-adapters.js'
import { runPromptAutomation, validateProviderProfile } from '../src/agent-provider-runner.js'
import { AgentProfiles, classifyProviderError, inspectPromptFile, probeProvider, safeProviderEnvironment } from '../src/agent-providers.js'

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-agent-providers-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const prompt = path.join(directory, 'prompt.md')
  await fs.writeFile(prompt, 'Return only concise structured findings.\n', { mode: 0o600 })
  return { directory, prompt, profiles: new AgentProfiles(path.join(directory, 'agent-profiles.json')) }
}

test('profiles keep an arbitrary provider model identifier and private prompt fingerprint', async (context) => {
  const { profiles, prompt } = await fixture(context)
  const profile = await profiles.set({ name: 'follow-up', provider: 'claude', model: 'claude-future-2030:preview', effort: 'xhigh', promptFile: prompt, timeoutMs: '90000' })
  assert.equal(profile.model, 'claude-future-2030:preview')
  assert.equal(profile.effort, 'xhigh')
  assert.equal(profile.timeoutMs, 90000)
  assert.equal(profile.prompt.path, await fs.realpath(prompt))
  assert.match(profile.prompt.sha256, /^[a-f0-9]{64}$/)
  assert.equal((await fs.stat(path.join(path.dirname(prompt), 'agent-profiles.json'))).mode & 0o777, 0o600)

  const reloaded = await profiles.get('follow-up')
  assert.equal(reloaded.model, 'claude-future-2030:preview')
})

test('profiles reject an effort setting that Codex CLI cannot apply', async (context) => {
  const { profiles, prompt } = await fixture(context)
  await assert.rejects(
    profiles.set({ name: 'codex-profile', provider: 'codex', model: 'gpt-future', effort: 'xhigh', promptFile: prompt }),
    /does not currently expose a per-invocation effort flag/,
  )
})

test('profiles accept Codex reasoning-effort nomenclature and keep it separate from Claude effort', async (context) => {
  const { profiles, prompt } = await fixture(context)
  const codex = await profiles.set({ name: 'codex-profile', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max', promptFile: prompt })
  assert.equal(codex.effort, null)
  assert.equal(codex.model, 'gpt-5.6-luna')
  assert.equal(codex.reasoningEffort, 'max')
  await assert.rejects(
    profiles.set({ name: 'wrong-dialect', provider: 'claude', model: 'opus', reasoningEffort: 'high', promptFile: prompt }),
    /does not use Codex-style reasoning effort/,
  )
})

test('profiles and adapters reject values that a provider could parse as flags', async (context) => {
  const { profiles, prompt } = await fixture(context)
  await assert.rejects(
    profiles.set({ name: 'unsafe', provider: 'claude', model: '--dangerously-bypass-approvals-and-sandbox', promptFile: prompt }),
    /cannot start with "-"/,
  )
  assert.throws(
    () => buildProviderInvocation({ provider: 'claude', model: '--dangerously-bypass-approvals-and-sandbox', effort: null, prompt: { path: '/private/prompt.md' } }),
    /safe model identifier/,
  )
})

test('updating a profile preserves its prompt unless an explicit new prompt is supplied', async (context) => {
  const { profiles, prompt } = await fixture(context)
  const created = await profiles.set({ name: 'follow-up', provider: 'claude', model: 'opus', promptFile: prompt })
  const updated = await profiles.set({ name: 'follow-up', model: 'sonnet' })
  assert.equal(updated.model, 'sonnet')
  assert.deepEqual(updated.prompt, created.prompt)
})

test('a profile may explicitly scope an automation to one owned workspace', async (context) => {
  const { directory, profiles, prompt } = await fixture(context)
  const profile = await profiles.set({ name: 'nelcor', provider: 'claude', model: 'opus', effort: 'medium', promptFile: prompt, workspace: directory })
  assert.deepEqual(profile.workspace, { path: await fs.realpath(directory) })
  assert.deepEqual((await profiles.set({ name: 'nelcor', workspace: null })).workspace, null)
  await assert.rejects(profiles.set({ name: 'bad-workspace', provider: 'claude', model: 'opus', promptFile: prompt, workspace: prompt }), /not a directory/)
})

test('concurrent profile writes retain both profiles', async (context) => {
  const { directory, prompt } = await fixture(context)
  const filename = path.join(directory, 'agent-profiles.json')
  await Promise.all([
    new AgentProfiles(filename).set({ name: 'a', provider: 'claude', model: 'opus', promptFile: prompt }),
    new AgentProfiles(filename).set({ name: 'b', provider: 'codex', model: 'gpt-5', promptFile: prompt }),
  ])
  assert.deepEqual((await new AgentProfiles(filename).list()).map((profile) => profile.name), ['a', 'b'])
})

test('a malformed profile document is not silently replaced', async (context) => {
  const { directory, profiles } = await fixture(context)
  const filename = path.join(directory, 'agent-profiles.json')
  const malformed = JSON.stringify({ version: 1, profiles: [] })
  await fs.writeFile(filename, malformed, { mode: 0o600 })
  await assert.rejects(profiles.list(), /malformed/)
  assert.equal(await fs.readFile(filename, 'utf8'), malformed)
})

test('prompt inspection notices a content change without exposing its contents', async (context) => {
  const { prompt } = await fixture(context)
  const before = await inspectPromptFile(prompt)
  await fs.writeFile(prompt, 'A materially changed prompt.\n', { mode: 0o600 })
  const after = await inspectPromptFile(prompt)
  assert.notEqual(after.sha256, before.sha256)
  assert.equal(after.path, await fs.realpath(prompt))
})

test('prompt inspection rejects a prompt that another local user could change', async (context) => {
  const { prompt } = await fixture(context)
  await fs.chmod(prompt, 0o622)
  await assert.rejects(inspectPromptFile(prompt), /must not be group- or world-writable/)
})

test('provider probe overlays detected capabilities from the installed CLI help', async (context) => {
  const { directory } = await fixture(context)
  const binary = path.join(directory, 'claude')
  await fs.writeFile(binary, '#!/bin/sh\n', { mode: 0o700 })
  const run = (_command, args) => args[0] === '--version'
    ? { status: 0, stdout: '2.1.220\n', stderr: '' }
    : { status: 0, stdout: '--model <model>\n--effort <level>\n--output-format <format>\n--no-session-persistence\n--tools\n--strict-mcp-config\n--system-prompt[-file]\n', stderr: '' }
  const result = await probeProvider('claude', { env: { PATH: directory }, run, now: () => '2026-08-01T00:00:00.000Z' })
  assert.equal(result.status, 'available')
  assert.equal(result.version, '2.1.220')
  assert.deepEqual(result.capabilities, { model: true, effort: true, stdinPrompt: true, structuredOutput: true, safeInvocation: true })
})

test('provider probe is degraded when a required safe invocation flag disappears', async (context) => {
  const { directory } = await fixture(context)
  const binary = path.join(directory, 'codex')
  await fs.writeFile(binary, '#!/bin/sh\n', { mode: 0o700 })
  const run = (_command, args) => args[0] === '--version'
    ? { status: 0, stdout: 'codex 1\n', stderr: '' }
    : { status: 0, stdout: '--model\n--sandbox\n--ephemeral\n--skip-git-repo-check\n--ignore-user-config\n--ignore-rules\n--json\n', stderr: '' }
  const result = await probeProvider('codex', { env: { PATH: directory }, run })
  assert.equal(result.status, 'degraded')
  assert.equal(result.issue, 'unsupported_flag')
  assert.match(result.detail, /safeInvocation/)
})

test('error classification puts an unknown model ahead of a generic not-found message', () => {
  assert.equal(classifyProviderError('API error: model claude-future not found'), 'unknown_model')
  assert.equal(classifyProviderError('command not found: claude'), 'binary_missing')
})

test('probe and invocation use the same narrow provider-specific environment', () => {
  const environment = safeProviderEnvironment('codex', {
    HOME: '/home/diego', PATH: '/bin', OPENAI_API_KEY: 'test-key', CODEX_HOME: '/private/codex', HTTPS_PROXY: 'https://proxy', GOOGLE_APPLICATION_CREDENTIALS: '/secret/google.json', TELEGRAM_TOKEN: 'secret',
  })
  assert.deepEqual(environment, { HOME: '/home/diego', PATH: '/bin', OPENAI_API_KEY: 'test-key', CODEX_HOME: '/private/codex', HTTPS_PROXY: 'https://proxy' })
})

test('adapters build fixed argv with stdin prompts and no arbitrary command surface', () => {
  const claude = buildProviderInvocation({ provider: 'claude', model: 'opus', effort: 'xhigh', prompt: { path: '/private/prompt.md' } })
  assert.deepEqual(claude, {
    command: 'claude',
    args: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--model=opus', '--effort=xhigh', '--system-prompt-file', '/private/prompt.md'],
  })
  const codex = buildProviderInvocation({ provider: 'codex', model: 'gpt-5', effort: null, prompt: { path: '/private/prompt.md' } }, { outputFile: '/private/result.txt' })
  assert.equal(codex.command, 'codex')
  assert.ok(codex.args.includes('--sandbox'))
  assert.ok(codex.args.includes('read-only'))
  assert.ok(codex.args.includes('--ignore-user-config'))
  assert.ok(codex.args.includes('--ignore-rules'))
  assert.ok(!codex.args.includes('--ask-for-approval'))
  assert.equal(codex.args.at(-1), '-')

  const codexReasoning = buildProviderInvocation({ provider: 'codex', model: 'gpt-5.6-luna', effort: null, reasoningEffort: 'max', prompt: { path: '/private/prompt.md' } }, { outputFile: '/private/result.txt' })
  assert.deepEqual(codexReasoning.args.slice(-5), ['--model=gpt-5.6-luna', '--config', 'model_reasoning_effort="max"', '--output-last-message', '/private/result.txt', '-'].slice(-5))
  assert.ok(codexReasoning.args.includes('model_reasoning_effort="max"'))

  const pinned = buildProviderInvocation({ provider: 'claude', model: 'opus', effort: null, prompt: { path: '/private/prompt.md' } }, { executable: '/private/bin/claude' })
  assert.equal(pinned.command, '/private/bin/claude')
})

test('automation invocations give the agent its wa capability without turning output into a structured action', () => {
  const codex = buildAutomationProviderInvocation(
    { provider: 'codex', model: 'gpt-5.6-luna', effort: null, reasoningEffort: 'max', prompt: { path: '/private/prompt.md' } },
    { outputFile: '/private/result.txt', stateDir: '/private/wa-state' },
  )
  assert.equal(codex.command, 'codex')
  assert.ok(codex.args.includes('danger-full-access'))
  assert.ok(codex.args.includes('--add-dir'))
  assert.ok(codex.args.includes('/private/wa-state'))
  assert.ok(!codex.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(codex.args.includes('model_reasoning_effort="max"'))

  const claude = buildAutomationProviderInvocation(
    { provider: 'claude', model: 'opus', effort: 'xhigh', prompt: { path: '/private/prompt.md' } },
    { stateDir: '/private/wa-state' },
  )
  assert.ok(claude.args.includes('Bash(wa *)'))
  assert.ok(claude.args.includes('--safe-mode'))
  assert.ok(!claude.args.includes('--dangerously-skip-permissions'))

  const workspaceClaude = buildAutomationProviderInvocation(
    { provider: 'claude', model: 'opus', effort: 'medium', prompt: { path: '/private/prompt.md' }, workspace: { path: '/private/nelcor' } },
    { stateDir: '/private/wa-state' },
  )
  assert.ok(workspaceClaude.args.includes('Read,Edit,Write,Bash'))
  assert.ok(workspaceClaude.args.includes('acceptEdits'))
  assert.ok(workspaceClaude.args.includes('/private/wa-state'))
})

async function script(directory, name, contents) {
  const filename = path.join(directory, name)
  await fs.writeFile(filename, contents, { mode: 0o700 })
  return filename
}

test('runner handles provider exit before stdin without crashing and returns a classified result', async (context) => {
  const { directory, prompt } = await fixture(context)
  const executable = await script(directory, 'fails-immediately', '#!/bin/sh\nexit 1\n')
  const result = await validateProviderProfile({ provider: 'claude', model: 'opus', effort: null, prompt: { path: prompt }, timeoutMs: 1000 }, { executable, timeoutMs: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'provider')
  assert.notEqual(result.issue, 'timeout')
})

test('runner reads Codex output-last-message and includes the configured prompt only on opt-in validation', async (context) => {
  const { directory, prompt } = await fixture(context)
  const executable = await script(directory, 'codex-probe', `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then shift; output="$1"; fi
  shift
done
input="$(cat)"
case "$input" in
  *"Return only concise structured findings."*) printf 'finished\\n' > "$output" ;;
  *) exit 9 ;;
esac
`)
  const profile = { provider: 'codex', model: 'gpt-5', effort: null, prompt: { path: prompt }, timeoutMs: 1000 }
  const result = await validateProviderProfile(profile, { executable, timeoutMs: 1000, withPrompt: true })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'with-prompt')
  assert.equal(result.responseMatchesProbe, false)
})

test('runner terminates a timed-out provider process', async (context) => {
  const { directory, prompt } = await fixture(context)
  const executable = await script(directory, 'hangs', '#!/bin/sh\nsleep 30\n')
  const startedAt = Date.now()
  const result = await validateProviderProfile({ provider: 'claude', model: 'opus', effort: null, prompt: { path: prompt }, timeoutMs: 1000 }, { executable, timeoutMs: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.issue, 'timeout')
  assert.ok(Date.now() - startedAt < 5000)
})

test('prompt automation runs a provider agent that uses wa itself and retains only audit output', async (context) => {
  const { directory, prompt, profiles } = await fixture(context)
  await fs.writeFile(prompt, 'Inspect the event and send the requested message with wa send florencia.\n', { mode: 0o600 })
  const profile = await profiles.set({ name: 'diego-to-flor', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max', promptFile: prompt, timeoutMs: 5000 })
  const executable = await script(directory, 'codex-agent', `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then shift; output="$1"; fi
  shift
done
input="$(cat)"
case "$input" in
  *"SOURCE-1"*"wa send florencia"*) ;;
  *) exit 9 ;;
esac
wa history florencia 1 >/dev/null 2>&1 && exit 7
wa send diego 'wrong destination' >/dev/null 2>&1 && exit 8
wa --help >/dev/null || exit 8
printf '%s\\n' 'Agent ran wa directly.' > "$output"
`)
  const stateDir = path.join(directory, 'wa-state')
  await fs.mkdir(path.join(stateDir, 'data'), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(stateDir, 'data', 'bridge-token'), 'test-bridge-token\n', { mode: 0o600 })
  const result = await runPromptAutomation(profile, {
    executable,
    stateDir,
    capabilityToken: 'test-capability-token',
    rule: { sourceTarget: 'diego', destinationTarget: 'florencia' },
    batch: { messageIds: ['SOURCE-1'] },
  })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'Agent ran wa directly.')
  assert.equal(result.error, null)
})

test('prompt automation refuses a modified prompt before it starts the provider', async (context) => {
  const { directory, prompt, profiles } = await fixture(context)
  const profile = await profiles.set({ name: 'tampered', provider: 'codex', model: 'gpt-5.6', promptFile: prompt })
  await fs.writeFile(prompt, 'Changed after profile approval.\n', { mode: 0o600 })
  const executable = await script(directory, 'must-not-run', '#!/bin/sh\nexit 44\n')
  await assert.rejects(
    runPromptAutomation(profile, { executable, stateDir: path.join(directory, 'wa-state'), capabilityToken: 'test-capability-token', rule: { sourceTarget: 'diego', destinationTarget: 'florencia' }, batch: { messageIds: ['SOURCE-1'] } }),
    /prompt changed after it was approved/,
  )
})
