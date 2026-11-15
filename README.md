# TGDrive

An encrypted, serverless drive that stores files in **your own private Telegram forum supergroup**. No backend, no database, no account to create — the browser talks MTProto directly to Telegram.

> **Status: M0 complete (verified live).** Login, group/topic provisioning, and an encrypted 200 MB round-trip work end-to-end against a real account via the **Spike lab** (`/debug`). The vault, drive UI, index, previews and trash are still to come. Treat this as a development build, not a backup product.

---

## How it works

```
Browser (Vue 3 + GramJS, MTProto over WSS)
  │
  ├─ files ──► chunk ──► AES-256-GCM ──► Telegram forum topic (one message per chunk)
  │
  └─ folder ─► forum topic
```

- **One drive group per person.** A private forum supergroup named `TGDrive · <name>`, placed in the Archive folder and with forwarding/saving disabled. Its description carries a `tgdrive:<driveId>` marker so the app finds it again instead of creating duplicates.
- **Topics are folders.** Folder names are the only readable labels in Telegram.
- **Files are chunked and encrypted on-device.** Up to 200 MB per file, one file at a time, 20 MB chunks by default (45 MB hard ceiling).
- **Unique key per file.** A random master key derives a per-file key with HKDF-SHA-256 (`file-v1:<fileId>`); every chunk is sealed with AES-256-GCM and bound to `fileId:index:count` as AAD.
- **No plaintext metadata.** Chunk file names are opaque IDs (`f_…-0001.bin`). File names, MIME types, folders metadata and the search index are designed to live in an encrypted vault/index, not in Telegram messages.
- **Session stays in this browser.** The MTProto session string is kept in `localStorage`; signing out revokes it.

### Planned key model

| Item | Plan |
| --- | --- |
| Master key | 32 random bytes, generated once per drive |
| Per-file key | `HKDF-SHA-256(master, "file-v1:<fileId>")` |
| Chunk format | `nonce (12 B) ‖ AES-256-GCM ciphertext+tag` |
| Vault | master key wrapped by an Argon2id KEK derived from a passphrase |
| Vault location | encrypted blob in the reserved `#index` topic (cross-device recovery) |
| Trash | reserved `#trash` topic, 30-day retention |

The M0 spike uses ephemeral keys only — there is **no recovery yet**, so do not put anything important through it.

---

## Security warnings

Read these before connecting a real account:

1. **`api_id` / `api_hash` are public in the bundle.** A browser-only MTProto app cannot hide them. Create a dedicated app at [my.telegram.org](https://my.telegram.org) for TGDrive; do not reuse the credentials of another client.
2. **A session string grants full account access.** It is stored in `localStorage` on this device. Avoid shared/borrowed machines, and use **Sign out** when done. Anyone with the string can act as you until it is revoked in Telegram → Settings → Devices.
3. **Telegram still sees traffic metadata.** It sees encrypted blobs, their sizes, timing, and the forum topic (folder) they land in. It does not see plaintext file contents or file names (once the vault/index lands).
4. **This is an unofficial client.** Automating a user account can violate Telegram's terms and trigger rate limits or restrictions, especially with repeated large uploads on a new account. Use a spare account while developing.
5. **Not a backup.** Telegram can restrict, delete or lose data. Keep another copy of anything you care about.

---

## Quick start

Requirements: **Node.js 22+**, npm 10+, and a Chromium-based browser for the smoke test.

```bash
git clone <your-repo-url> tg-drive
cd tg-drive
npm install

cp .env.example .env.local
# then edit .env.local
npm run dev
```

Create credentials at **my.telegram.org → API development tools → App configuration** and set:

```dotenv
VITE_TG_API_ID=12345678
VITE_TG_API_HASH=0123456789abcdef0123456789abcdef
# optional
VITE_TG_CHUNK_SIZE=20971520
```

`vite build` also reads `.env`; `.env.local` and `.env` are git-ignored. If no env credentials are present, the login page shows a one-time form and stores them in `localStorage` instead.

Open the printed URL, scan the QR code with **Telegram → Settings → Devices → Link Desktop Device**, or use the phone/2FA fallback.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on `:5173` |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint (flat config, Vue + JS) |
| `npm run format` | Prettier |
| `npm run smoke` | Build, then headless-Chrome checks: login renders, route guard redirects, no fatal console errors |

The smoke test is hermetic: it maps `*.telegram.org` to localhost so it never touches the real network.

---

## M0 spike lab (`/debug`)

The lab proves the storage primitives against your real account:

1. **Find or create group** — creates the forum supergroup once, archives it, disables forwarding. **Verify** re-reads the `tgdrive:` marker; running it again must not create a second group.
2. **Topics** — create/select a topic, refresh the topic list.
3. **Message probe** — send a small document into the topic, read it back, delete it.
4. **Encrypted chunk round-trip** — choose a file up to 200 MB, pick a chunk size, upload encrypted chunks, download them, decrypt, and compare SHA-256 hashes. Optionally delete the chunk messages afterwards.
5. **Live log** — every Telegram call and error, including flood waits, is visible in the right-hand panel.

Suggested first run: a 20–50 MB file with the default 20 MB chunk size, then a full 200 MB file once the small round-trip is green.

---

## Project layout

```
src/
  main.js                 app bootstrap, polyfills, router, Pinia
  polyfills.js            Buffer/process globals for GramJS
  lib/
    config.js             env credentials, limits, storage keys
    logger.js             in-memory logger used by the spike lab
    utils.js              formatting helpers
    crypto/bytes.js       base64/hex/random helpers
    crypto/kdf.js         HKDF, Argon2id/PBKDF2 KEKs, AES-GCM
    crypto/chunk.js       worker-backed encrypt/decrypt/SHA-256
    telegram/session.js   session string persistence
    telegram/topics.js    group, forum topic, message, upload helpers
    telegram/roundtrip.js M0 encrypt → upload → download → verify pipeline
  stores/auth.js          GramJS client lifecycle, QR/phone auth
  views/                  Login, Drive (placeholder), Spike lab, 404
  components/ui/          small Tailwind UI primitives
  workers/crypto.worker.js WebCrypto worker (keys never leave the device)
```

GramJS is a Node-oriented library, so Vite uses `vite-plugin-node-polyfills` for `crypto`, `util`, `stream`, `events` and friends, plus a `Buffer`/`process` bootstrap. This is why the main bundle is large (~1.7 MB before gzip); it is a known trade-off of browser MTProto.

---

## Deploying to Cloudflare Pages

The app is a static SPA. Build it with:

- **Framework preset:** None / Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node version:** 22

Set `VITE_TG_API_ID` and `VITE_TG_API_HASH` as **Production and Preview** environment variables in the Pages project (they are compiled into the bundle at build time). `public/_redirects` supplies the SPA fallback, and `public/_headers` sets CSP, `X-Frame-Options: DENY`, no-referrer and related headers.

The GitHub repo is ready for a later “Connect to Git” step: push the repo, then point Cloudflare Pages at it. The included workflow (`.github/workflows/build.yml`) builds on pushes/PRs; add `VITE_TG_API_ID` and `VITE_TG_API_HASH` as repository secrets if you want its artifact to be usable.

> The CSP allows `'wasm-unsafe-eval'` because `hash-wasm` instantiates WebAssembly for Argon2id. It does not allow general `eval`.

---

## Roadmap

| Milestone | Scope |
| --- | --- |
| **M0** | MTProto login, group/topic lifecycle, encrypted chunk round-trip — **done** |
| M1 | Passphrase-derived vault, master key wrap/unwrap, cross-device recovery |
| M2 | Drive UI: folders ↔ topics, upload queue, chunk manifest |
| M3 | Encrypted index snapshot + event log in `#index`, local IndexedDB cache, MiniSearch |
| M4 | Search/filter by category (images/video/audio/documents), retry/resume, flood handling |
| M5 | Previews ≤50 MB, trash + 30-day retention, download/export |
| M6 | Polish: PWA/offline shell, themes, keyboard shortcuts, storage stats |

## Known limitations

- No vault yet: clearing browser storage loses the session and the spike keys.
- No drive UI, index, search, trash or previews yet.
- 200 MB per file and one upload at a time; Telegram rate limits still apply per chat.
- “Archived” means the group is placed in your client's Archive folder; the app never deletes the group.
- Telegram channel/supergroup limits and account restrictions can change without notice.
- Low-severity npm advisories exist in the dev-only `vite-plugin-node-polyfills` dependency tree; production dependencies audit clean.

## License

Private / unlicensed unless a license is added before publishing.
