import path from 'node:path'

export const systemdServiceName = 'whatsapp-assistant.service'

function escapeSystemdValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
}

function quoted(value) {
  return `"${escapeSystemdValue(value)}"`
}

function directivePath(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\x09')
    .replace(/\n/g, '\\n')
}

export function systemdUserUnitPath({ home, env = process.env }) {
  const configured = env.XDG_CONFIG_HOME?.trim()
  const configHome = configured && path.isAbsolute(configured) ? configured : path.join(home, '.config')
  return path.join(configHome, 'systemd', 'user', systemdServiceName)
}

export function systemdUserUnit({ nodePath, entryPath, entryArguments = [], stateRoot, logsDir, workingDirectory = path.dirname(entryPath), bridgePort = null }) {
  const stdoutPath = path.join(logsDir, 'bridge.log')
  const stderrPath = path.join(logsDir, 'bridge-error.log')
  const execStart = [nodePath, entryPath, ...entryArguments].map(quoted).join(' ')
  const bridgePortLine = bridgePort ? `Environment="WA_BRIDGE_PORT=${escapeSystemdValue(bridgePort)}"\n` : ''
  return `[Unit]
Description=WhatsApp Assistant local bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${directivePath(workingDirectory)}
Environment="WA_STATE_DIR=${escapeSystemdValue(stateRoot)}"
${bridgePortLine}Environment="PATH=${escapeSystemdValue(`${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)}"
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${directivePath(stdoutPath)}
StandardError=append:${directivePath(stderrPath)}

[Install]
WantedBy=default.target
`
}
