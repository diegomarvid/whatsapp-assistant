# Initial QR linking: fix and validation

## Evidence and limits

The 30-day policy selects full history. Previously the bridge also selected
`Browsers.macOS('Desktop')`, which changes Baileys' registration payload to a
desktop subplatform. Upstream issue 2671 contains A/B reports that this descriptor
causes 428 before QR and that `macOS('Chrome')` succeeds with the same host,
credentials and Web version:
https://github.com/WhiskeySockets/Baileys/issues/2671

This is a concrete compatibility candidate, not a confirmed diagnosis of the
affected machine. No sanitized registration log or phone scan from that machine
has yet been collected. A 428 is a connection termination, not evidence of an
account ban. Official Web succeeding also does not prove a third-party handshake
will succeed. The earlier failure at seven days may have another cause.

The fix uses Chrome while preserving `syncFullHistory` and the selected retention.
Baileys still encodes `requireFullSync: true`; WhatsApp decides what history it
actually sends. rc14 is pinned; its upstream changes include a Web-version refresh,
not a documented universal registration fix:
https://github.com/WhiskeySockets/Baileys/compare/v7.0.0-rc13...v7.0.0-rc14

QRs now come only from an authenticated, no-store endpoint on the active bridge.
They expire after 60 seconds, are invalidated on close/open/shutdown/socket
replacement, and are rechecked after image rendering. Setup and doctor consult
live status instead of trusting old files. A displayed image cannot be revoked
from Preview; its printed deadline still applies. Run `wa qr` for a current one.
Failed initial registration stops automatically. One 515 pair-success restart is
allowed; established sessions retain their normal reconnect behavior. Auth files
and cache are never deleted. QR values are not written to daemon logs.

## Update on the affected Mac

Keep the daemon stopped during installation. In the affected checkout, preserve
any local source edits before applying the supplied patch (a local commit is fine).
Do not stash, copy into Git, or remove private auth/data directories. The patch
replaces the previous QR-file cleanup with the live-lease implementation; resolve
any overlap in `src/server.js` before proceeding.

Apply the supplied patch from the checkout with `git am --3way /path/to/patch`.
If Git reports a conflict, stop and resolve it; do not reset the private state.
Then:

```sh
npm ci
npm run check
npm test
export WA_STATE_DIR="$HOME/Library/Application Support/WhatsApp Assistant"
node bin/wa.js history-policy show
```

The policy must report `retentionDays: 30` and `syncFullHistory: true`.
If it does not, stop and investigate the selected state directory. This update
must not silently choose another policy. Node 24.13.1 meets the package's >=22
requirement. All 152 tests also pass locally using the exact Node 24.13.1 runtime
(and Node 26.5.0). Run the gates on the affected Mac before starting its bridge.

For one controlled attempt, run the checkout directly rather than an older global
installation. Confirm `wa daemon status` shows it stopped first:

```sh
node src/server.js > "$WA_STATE_DIR/logs/link-validation.log" 2>&1
```

Leave that terminal running. In a second terminal in the same checkout:

```sh
export WA_STATE_DIR="$HOME/Library/Application Support/WhatsApp Assistant"
node bin/wa.js doctor
node bin/wa.js qr
```

Scan before the printed deadline. If the phone rejects it or the bridge closes,
stop the foreground bridge with Ctrl-C. Do not keep scanning or restart in a loop.
The log contains `link.start`, `link.qr`, and `link.closed` records with protocol
version, browser, Node version, registration flag, expiry, status code and retry
choice. Share only those JSON records, not the full log: other existing bridge
logs can include private identifiers. No account restriction should be inferred
without additional evidence.

## Phone acceptance checklist (not covered by automated tests)

1. Scan once on the affected phone; capture whether it accepts the device.
2. `node bin/wa.js status` must reach `connection: open`, healthy ingestion and
   `presenceUnavailableAssertedAt` after the connection timestamp.
3. Arrange an incoming test message from another device. Use `wa find`,
   `wa coverage <alias>` and `wa latest-incoming <alias>` (through
   `node bin/wa.js`) to verify that exact new message with fresh coverage.
   History replay or a changed message count alone is not proof of reception.
4. Ctrl-C the foreground bridge and start the same command again. It must open
   without a QR, then receive a second new test message. Recheck retention is 30.
5. Only after this succeeds, stop the foreground bridge and install the updated
   checkout's daemon with `node bin/wa.js daemon install`. Check its service entry
   points at this checkout and `node bin/wa.js status` reaches open again.

Automatic verification covers QR expiry, disconnected/old-generation rejection,
rotation, CLI rejection of stale files/expired leases/unavailable bridge, full
history preservation and bounded initial reconnect decisions, plus the complete
existing regression suite. It cannot establish linking, history availability,
phone notifications or live message reception on another Mac.
