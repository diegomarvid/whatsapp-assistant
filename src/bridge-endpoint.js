export const DEFAULT_BRIDGE_PORT = 3847

// The CLI and the bridge must always agree on the endpoint, so both read it
// from here. The API stays loopback-only regardless of the chosen port.
export function bridgePort(env = process.env) {
  const value = Number.parseInt(env.WA_BRIDGE_PORT || '', 10)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_BRIDGE_PORT
}

export function bridgeBaseUrl(env = process.env) {
  return `http://127.0.0.1:${bridgePort(env)}`
}
