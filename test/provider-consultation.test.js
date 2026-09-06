import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runPromptAutomation } from '../src/agent-provider-runner.js'
import { inspectPromptFile } from '../src/agent-providers.js'
import { buildAutomationProviderInvocation } from '../src/agent-provider-adapters.js'
import { workspaceCheckpoint } from '../src/workspace-checkpoint.js'

const exec = promisify(execFile)
const sessionId = '00000000-0000-4000-8000-000000000001'
async function fixture(t, provider) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-native-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'prompt.md'); await fs.writeFile(file, 'A bounded test.', { mode: 0o600 })
  return { directory, profile: { name: 'sample', provider, model: provider === 'claude' ? 'opus' : 'gpt-5.6-sol', prompt: await inspectPromptFile(file) }, rule: { sourceTarget: 'sample', destinationTarget: 'sample', mode: 'live', humanConsultation: {} }, batch: { id: 'sample-work', messageIds: [] } }
}

test('Codex resumes the pinned session with renewed credentials and the exact CLI entrypoint', async (t) => {
  const f = await fixture(t, 'codex'); const executable = path.join(f.directory, 'provider.cjs')
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2); const input = fs.readFileSync(0, 'utf8');
if (args.includes('--ephemeral') || !input.includes('login:false') || !input.includes('trusted executable')) process.exit(4);
const token = fs.readFileSync(path.join(process.env.WA_STATE_DIR, 'data', 'bridge-token'), 'utf8').trim();
const prior = path.join(process.cwd(), 'prior-token');
if (fs.existsSync(prior)) {
  if (!args.includes('resume') || args[args.indexOf('resume') + 1] !== '${sessionId}' || fs.readFileSync(prior, 'utf8') === token) process.exit(5);
}
fs.writeFileSync(prior, token);
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'OK');
console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));
`, { mode: 0o700 })
  const input = { rule: f.rule, batch: f.batch, stateDir: f.directory, executable, capabilityToken: 'first-token' }
  const first = await runPromptAutomation(f.profile, input); assert.equal(first.ok, true)
  await assert.rejects(fs.access(path.join(first.session.cwd, 'wa-state')))
  const resumed = await runPromptAutomation(f.profile, { ...input, capabilityToken: 'second-token', batch: { ...f.batch, providerSessions: { execute: first.session } } })
  assert.equal(resumed.ok, true); assert.equal(resumed.session.id, first.session.id); assert.equal(resumed.session.cwd, first.session.cwd)
  await assert.rejects(runPromptAutomation({ ...f.profile, model: 'different' }, { ...input, batch: { ...f.batch, providerSessions: { execute: first.session } } }), /changed/)
})

test('Claude native deferred results require the hook receipt and never become ordinary success', async (t) => {
  const f = await fixture(t, 'claude'); const executable = path.join(f.directory, 'provider.cjs')
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'); fs.readFileSync(0);
const tool={id:'tool-1',name:'AskUserQuestion',input:{questions:[{question:'Which color?'}]}};
fs.writeFileSync(path.join(process.cwd(),'native-pending.json'),JSON.stringify({tool_use_id:'tool-1'}));
console.log(JSON.stringify({session_id:'${sessionId}',is_error:false,stop_reason:'tool_deferred',deferred_tool_use:tool}));
`, { mode: 0o700 })
  const input = { rule: f.rule, batch: f.batch, stateDir: f.directory, executable, capabilityToken: 'first-token' }
  const result = await runPromptAutomation(f.profile, input); assert.equal(result.ok, true); assert.equal(result.nativeQuestion.id, 'tool-1')
  let source = await fs.readFile(executable, 'utf8'); source = source.replace("stop_reason:'tool_deferred'", "stop_reason:'end_turn'")
  await fs.writeFile(executable, source)
  const ignored = await runPromptAutomation(f.profile, input); assert.equal(ignored.ok, false); assert.match(ignored.error, /did not safely defer/)
})

test('native hook binds answers to the deferred tool and the permission fallback always denies', async (t) => {
  const f = await fixture(t, 'claude'); const pending = path.join(f.directory, 'pending'); const answer = path.join(f.directory, 'answer')
  const { spawn } = await import('node:child_process')
  const run = (script, args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args]); let output = ''; child.stdout.on('data', (c) => { output += c }); child.on('error', reject); child.on('close', () => resolve(JSON.parse(output))); child.stdin.end(JSON.stringify(input) + '\n')
  })
  await fs.writeFile(answer, JSON.stringify({ id: 'expected', answers: { 'Which color?': 'Blue' } }))
  const request = { tool_name: 'AskUserQuestion', tool_use_id: 'other', tool_input: { questions: [{ question: 'Which color?' }] } }
  const hook = new URL('../src/claude-human-hook.js', import.meta.url).pathname
  assert.equal((await run(hook, [pending, answer], request)).hookSpecificOutput.permissionDecision, 'defer')
  assert.equal((await run(hook, [pending, answer], { ...request, tool_use_id: 'expected' })).hookSpecificOutput.updatedInput.answers['Which color?'], 'Blue')
  const result = await run(new URL('../src/claude-permission-server.js', import.meta.url).pathname, [], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Bash', input: { command: 'unexpected' } } } })
  assert.equal(JSON.parse(result.result.content[0].text).behavior, 'deny')
})

test('native invocation excludes stock plugins, pins session ID and repeats controlled permissions', () => {
  const invocation = buildAutomationProviderInvocation({ provider: 'claude', model: 'opus' }, { stateDir: '/private/state', session: { id: sessionId }, consultation: { sessionId, settings: '/private/settings.json', mcp: '/private/mcp.json' } })
  for (const flag of ['--restricted', '--setting-sources', '--strict-mcp-config', '--permission-prompt-tool', '--resume']) assert.ok(invocation.args.includes(flag))
  assert.ok(!invocation.args.includes('--no-session-persistence')); assert.ok(!invocation.args.includes('--safe-mode')); assert.ok(!invocation.args.includes('--dangerously-skip-permissions'))
  assert.throws(() => buildAutomationProviderInvocation({ provider: 'codex', model: 'sample' }, { stateDir: '/private/state', outputFile: '/private/output', session: { id: '--last' } }), /UUID/)
})

test('workspace checkpoint detects changed tracked and untracked content', async (t) => {
  const f = await fixture(t, 'codex')
  await exec('git', ['init', f.directory]); await exec('git', ['-C', f.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'])
  const first = await workspaceCheckpoint(f.directory)
  await fs.writeFile(path.join(f.directory, 'prompt.md'), 'Changed')
  const second = await workspaceCheckpoint(f.directory); assert.notEqual(first.digest, second.digest)
  await exec('git', ['-C', f.directory, 'add', 'prompt.md']); await exec('git', ['-C', f.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'])
  const tracked = await workspaceCheckpoint(f.directory); assert.notEqual(second.head, tracked.head)
})
