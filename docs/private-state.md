# Public code, private state

This repository is designed to be safe to publish. The code and documentation
are public; a user's WhatsApp account state never is.

## Public (tracked in Git)

- Bridge and CLI source code (`src/`, `bin/`).
- Generic documentation, setup instructions and command examples.
- Package manifests and lockfiles.
- This privacy contract.

No real phone numbers, aliases, conversations, transcripts, QR values, session
files, API tokens, or media belong in tracked files, commit messages, issues or
pull requests.

## Private (local only, ignored by Git)

| Path | Contents |
| --- | --- |
| `auth/` | Linked-device credentials produced by the QR flow. |
| `data/bridge-token` | Loopback API bearer token. |
| `data/aliases.json` | Personal aliases, names and phone-number mappings. |
| `data/mirror.sqlite` (and WAL files) | Durable seven-day mirror: normalized messages, raw recovery envelopes, retry counters and redacted technical event audit. |
| `data/messages.json` | Legacy cache used only for one-time migration into the SQLite mirror. |
| `data/audio-envelopes/` | Private metadata needed to download selected recent audios. |
| `data/audio/` | Audio files downloaded only for requested transcriptions. |
| `data/image-envelopes/`, `data/images/` | Private image metadata and selected downloaded images. |
| `data/document-envelopes/`, `data/documents/` | Private document metadata and selected downloaded files. |
| `data/link-qr.png`, `data/link-qr.txt` | Temporary QR image and terminal representation used during intentional onboarding/re-linking. |
| `data/*.log` | Local runtime diagnostics. |

The repository `.gitignore` excludes `auth/` and `data/`. Directories are
created with private permissions by the bridge. Do not weaken these ignores.

## Adding a private preference

Use the local CLI, never a committed configuration file:

```bash
wa alias add contacto +598XXXXXXXX "Nombre del contacto"
```

That creates or updates the local `data/aliases.json` entry. It allows requests
such as `wa latest contacto` without exposing the contact's identity in the
public repository.

## Before publishing a fork or change

Run:

```bash
git status --short
git check-ignore -v auth data
git ls-files | xargs rg -n -i 'real-phone-or-alias-to-check'
```

Review any new examples, docs and commit messages for real personal data. If a
private value was committed locally by mistake, do not push that history; create
a clean public export or rewrite the local-only history before publication.
