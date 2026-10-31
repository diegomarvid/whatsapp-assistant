// The WhatsApp Web version the bridge announces when it connects. Baileys'
// fetchLatestBaileysVersion reads a JSON file in the Baileys repository that
// can lag the live client by weeks; registering a new device with a stale
// version is a known cause of "Can't link new devices right now". The live
// service worker of web.whatsapp.com is the source of truth, the Baileys file
// is the fallback, and the version bundled with Baileys is the last resort.
export const VERSION_TIMEOUT_MS = 8000

function validVersion(version) {
  return Array.isArray(version) && version.length === 3 && version.every((part) => Number.isInteger(part) && part >= 0)
}

function withTimeout(promise, timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

export async function resolveWaVersion({ fetchWeb, fetchBaileys, bundled, timeoutMs = VERSION_TIMEOUT_MS }) {
  const failures = []
  for (const [source, fetcher] of [['web.whatsapp.com', fetchWeb], ['baileys-repository', fetchBaileys]]) {
    try {
      const result = await withTimeout(Promise.resolve().then(fetcher), timeoutMs)
      // Both Baileys fetchers report a failed lookup as isLatest: false while
      // still returning a (bundled) version; only a confirmed one is accepted.
      if (result?.isLatest && validVersion(result.version)) return { version: result.version, source, failures }
      failures.push({ source, error: result?.error?.message || 'unconfirmed version' })
    } catch (error) {
      failures.push({ source, error: error.message })
    }
  }
  return { version: bundled, source: 'bundled', failures }
}
