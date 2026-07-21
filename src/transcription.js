import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, tryRun } from './exec.js'
import { paths, projectRoot } from './runtime-paths.js'
import { ensureRuntimeDirectories } from './state-dirs.js'
import { cachedCompatibleModels, defaultModelFor, selectLocalModel, transcriptionBackend } from './transcription-runtime.js'

const { dataDir, stateRoot } = paths
const transcriptionConfigPath = path.join(dataDir, 'transcription.json')
const transcriptionVenvPath = path.join(stateRoot, 'transcribe-venv')
const transcriptionPythonPath = path.join(transcriptionVenvPath, 'bin', 'python')
const transcriptionScript = path.join(projectRoot, 'src', 'transcribe-audio.py')
const pullModelScript = path.join(projectRoot, 'src', 'pull-whisper-model.py')

async function loadTranscriptionConfig() {
  try { return JSON.parse(await fs.readFile(transcriptionConfigPath, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveTranscriptionConfig(config) {
  await ensureRuntimeDirectories()
  await fs.writeFile(transcriptionConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function pythonForSetup() {
  const candidates = [process.env.WA_PYTHON, 'python3'].filter(Boolean)
  for (const candidate of candidates) {
    const result = tryRun(candidate, ['-c', 'import sys; print(sys.executable)'])
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  }
  return null
}

function backendImportName(backend) {
  return backend === 'mlx' ? 'mlx_whisper' : 'faster_whisper'
}

function privateRuntimeReady(backend) {
  if (!existsSync(transcriptionPythonPath)) return false
  return tryRun(transcriptionPythonPath, ['-c', `import ${backendImportName(backend)}`]).status === 0
}

function activeTranscriptionRuntime(config) {
  const backend = transcriptionBackend()
  const selected = selectLocalModel({ backend, configuredModel: config.model, home: os.homedir() })
  return {
    backend,
    selected,
    defaultModel: defaultModelFor(backend),
    runtimePathExists: existsSync(transcriptionPythonPath),
    runtimeInstalled: privateRuntimeReady(backend),
  }
}

export async function transcriptionDoctor() {
  const config = await loadTranscriptionConfig()
  const runtime = activeTranscriptionRuntime(config)
  const ffmpegAvailable = tryRun('ffmpeg', ['-version']).status === 0
  console.log(JSON.stringify({
    ...runtime,
    configuredModel: config.model || null,
    language: config.language || 'es',
    runtimePath: transcriptionPythonPath,
    ffmpegAvailable,
    cachedCompatibleModels: cachedCompatibleModels(runtime.backend, { home: os.homedir() }),
    downloadsModelsAutomatically: false,
    nextStep: !runtime.runtimeInstalled
      ? runtime.runtimePathExists
        ? `The private runtime is incomplete (missing ${backendImportName(runtime.backend)}). The next \`wa transcribe\` repairs it automatically without downloading a model.`
        : 'Run `wa transcribe` to create a private Python runtime automatically. This does not download a model.'
      : runtime.backend === 'mlx' && !ffmpegAvailable
        ? 'Install ffmpeg (for example, `brew install ffmpeg`) before transcribing audio on Apple Silicon.'
      : !runtime.selected
        ? `Ask the user before downloading ${runtime.defaultModel}, then run \`wa transcribe pull ${runtime.defaultModel}\`, or configure an existing directory with \`wa transcribe config model-path <dir>\`.`
        : 'ready',
  }, null, 2))
}

export async function setupTranscription({ verbose = true } = {}) {
  await ensureRuntimeDirectories()
  const backend = transcriptionBackend()
  if (!existsSync(transcriptionPythonPath)) {
    const python = pythonForSetup()
    if (!python) throw new Error('Python 3 is required for local transcription. Install Python 3, then run `wa transcribe setup`.')
    run(python, ['-m', 'venv', transcriptionVenvPath])
  }
  run(transcriptionPythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  const dependencies = backend === 'mlx' ? ['mlx-whisper', 'huggingface-hub'] : ['faster-whisper', 'huggingface-hub']
  run(transcriptionPythonPath, ['-m', 'pip', 'install', ...dependencies])
  if (verbose) {
    console.log(`Installed ${backend} in ${transcriptionVenvPath}. No Whisper model was downloaded.`)
    await transcriptionDoctor()
  }
}

export async function pullTranscriptionModel(requestedModel) {
  const config = await loadTranscriptionConfig()
  const runtime = activeTranscriptionRuntime(config)
  if (!runtime.runtimeInstalled) throw new Error('Run `wa transcribe setup` before downloading a model.')
  const model = requestedModel || config.model || runtime.defaultModel
  if (path.isAbsolute(model)) throw new Error('A local model path cannot be downloaded. Configure a Hugging Face model ID instead.')
  console.log(`Downloading Whisper model ${model}...`)
  const result = run(transcriptionPythonPath, [pullModelScript, model], { timeout: 30 * 60 * 1000 })
  await saveTranscriptionConfig({ ...config, model })
  console.log(result)
}

export async function configureTranscription(args) {
  const action = args.shift()
  if (action === 'show') return transcriptionDoctor()
  const value = args.join(' ').trim()
  if (!value || !['model', 'model-path', 'language'].includes(action)) throw new Error('Use: wa transcribe config show|model <huggingface-id>|model-path <directory>|language <code|auto>')
  const config = await loadTranscriptionConfig()
  if (action === 'language') {
    const language = value.toLocaleLowerCase()
    if (language !== 'auto' && !/^[a-z]{2,3}$/.test(language)) throw new Error('Use an ISO language code such as es or en, or auto for Whisper detection.')
    await saveTranscriptionConfig({ ...config, language })
    return console.log(`Configured transcription language: ${language}`)
  }
  if (action === 'model-path') {
    const absolutePath = path.resolve(value)
    const stat = await fs.stat(absolutePath).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`Model directory not found: ${absolutePath}`)
    await saveTranscriptionConfig({ ...config, model: absolutePath })
    return console.log(`Configured local Whisper model: ${absolutePath}`)
  }
  if (!/^[^\s/]+\/[^\s/]+$/.test(value)) throw new Error('Use a Hugging Face model ID such as mlx-community/whisper-large-v3-turbo.')
  await saveTranscriptionConfig({ ...config, model: value })
  console.log(`Configured Whisper model: ${value}. It will not download until you run wa transcribe pull.`)
}

export async function transcribe(audioPath) {
  const config = await loadTranscriptionConfig()
  let runtime = activeTranscriptionRuntime(config)
  if (!runtime.runtimeInstalled) {
    process.stderr.write(`Preparing the private ${runtime.backend} transcription runtime (one time; no model download)…\n`)
    await setupTranscription({ verbose: false })
    runtime = activeTranscriptionRuntime(config)
  }
  if (!runtime.runtimeInstalled) throw new Error(`Could not initialize the private ${runtime.backend} transcription runtime. Run \`wa transcribe setup\` for the detailed installer output.`)
  if (!runtime.selected) throw new Error(`No compatible Whisper model is installed locally. Ask the user before downloading ${runtime.defaultModel}; then run: wa transcribe pull ${runtime.defaultModel}`)
  const language = config.language || 'es'
  const result = run(transcriptionPythonPath, [transcriptionScript, runtime.backend, runtime.selected.path, language, audioPath], { timeout: 10 * 60 * 1000 })
  return result.trim()
}
