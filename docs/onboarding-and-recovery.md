# Onboarding, cache and recovery

This is the operational source of truth for the local WhatsApp assistant.
Its goal is to make the normal path reliable without repeatedly asking the user
to scan a QR code.

## Normal operating mode

- Baileys runs as the macOS LaunchAgent
  `com.diegomarvid.whatsapp-bridge`.
- It listens only on `127.0.0.1:3847`; it does not expose an internet-facing
  API and it has no send-message endpoint.
- The linked-device session lives in `auth/`. As long as that directory stays
  intact, a restart or Mac reboot reconnects automatically and **does not need
  another QR**.
- WhatsApp is requested in **recent sync** mode (`syncFullHistory: false`).
  The provider chooses the precise size of that initial recent window.
- The local cache keeps only the newest 30 days, capped at 10,000 messages.
  Older data is deliberately pruned. This is not a complete WhatsApp archive.
- Audio envelopes for messages within that same window are stored privately so
  their audio can be downloaded later only when a transcription is requested.

All sensitive runtime state is under `data/` or `auth/`, is private to the
local user, and is excluded from Git.

## One-time onboarding

1. Install dependencies and the local CLI:

   ```bash
   npm install
   npm link
   ```

2. Load or start the LaunchAgent:

   ```bash
   launchctl bootstrap gui/$(id -u) \
     "$HOME/Library/LaunchAgents/com.diegomarvid.whatsapp-bridge.plist"
   ```

3. Scan the QR shown at `data/link-qr.png` only if `auth/` has not been
   created yet, or WhatsApp explicitly logged the device out.
4. Wait for `wa status` to report `"connection": "open"`. The cache count can
   rise for a little while after that as the recent sync arrives.

After this first link, do not scan again just because a query looks old. First
check the cache window and service health below.

## Everyday CLI

```bash
wa status
wa aliases
wa alias add contacto +598XXXXXXXX "Nombre del contacto"
wa find "Nombre del contacto"
wa latest contacto
wa history contacto 20
wa search contacto "presupuesto"
wa transcribe contacto latest
```

Aliases live in `data/aliases.json`, not in Git. When the user supplies a stable
name/number mapping, save it with `wa alias add` so later requests like
“buscá el último mensaje de un contacto” stay one command.

`wa transcribe <alias> latest` does this locally:

1. Finds the most recent audio in that chat.
2. Uses Baileys to download only that selected audio.
3. Runs `ct transcribe <audio> es`.
4. Prints the transcript. It does not send anything to the contact.

## Recovery checklist — before ever asking for a QR

1. Check the daemon and cache:

   ```bash
   wa status
   launchctl print gui/$(id -u)/com.diegomarvid.whatsapp-bridge
   ```

2. If it is not `open`, restart the existing service only:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.diegomarvid.whatsapp-bridge
   ```

   Wait a few seconds and run `wa status` again. This preserves the linked
   session and normally reconnects without interaction.

3. If a conversation seems to be missing, inspect the cache's oldest/newest
   timestamp first. Messages older than about 30 days are intentionally absent.
   The assistant is for recent operational context, not an archive.

4. If `wa transcribe` says an old audio is unavailable, it may predate the
   current recent-sync window or the audio-envelope capture. Do **not** reset
   the session automatically. Explain that limitation and ask whether the user
   wants a deliberate re-link/re-sync.

## QR is the last resort

Only request a QR when one of these is true:

- WhatsApp marked the linked device as logged out.
- `auth/` was genuinely lost or corrupted and a service restart did not help.
- The user explicitly asks to deliberately re-link and accepts a new recent
  sync.

Before re-linking, back up `auth/` inside ignored `data/`, never delete it
blindly. Preserve the current cache and aliases. Then show one fresh QR and
wait for the user to scan it; do not cycle QRs or alter sync settings again
while waiting.

## Explicit guardrails

Never do these as a reaction to an ordinary missing-message report:

- Set `syncFullHistory: true` or force full history processing.
- Clear/move `auth/`.
- Delete `data/messages.json` or `data/aliases.json`.
- Re-link the device just to obtain a message older than the 30-day policy.

Those actions either widen the privacy scope or force an unnecessary QR. State
the trade-off and get the user's explicit agreement first.
