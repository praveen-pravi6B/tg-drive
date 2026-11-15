# TGDrive

An encrypted, serverless drive that stores files in **your own private Telegram forum supergroup**. No backend, no database, no account to create — the browser talks MTProto directly to Telegram.

> **Status: M2 in progress.** Vault recovery (M1) and a basic drive UI are in place: folders map to forum topics, single-file uploads are chunked/encrypted with vault-derived keys, and an encrypted manifest per file is stored in the folder topic for listing/download/delete. A full encrypted index, search, previews and trash are still to come. Treat this as a development build, not a backup product.

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

### Key model

| Item           | Implementation                                                              |
| -------------- | --------------------------------------------------------------------------- |
| Master key     | 32 random bytes, generated once per drive, never stored unwrapped           |
| Per-file key   | `HKDF-SHA-256(master, "file-v1:<fileId>")`                                  |
| Chunk format   | `nonce (12 B) ‖ AES-256-GCM ciphertext+tag`, AAD `fileId:index:count`       |
| Vault          | master key wrapped by an Argon2id KEK derived from a passphrase             |
| Vault envelope | AES-256-GCM, AAD bound to `tgdrive:vault-v1:1:<driveId>`                    |
| Vault location | one opaque `v.bin` document (caption `tgv1`) in the reserved `#index` topic |
| Trash          | reserved `#trash` topic, 30-day retention (planned)                         |

Argon2id defaults are 64 MiB, 3 passes and a 16-byte random salt; parameters live in the envelope, so they can be raised later without breaking existing vaults. Rewriting the vault replaces the previous envelope and deletes it, so `#index` holds exactly one.

The M0 spike lab still uses ephemeral keys for its round-trip; the vault is what makes files recoverable across reloads and devices.

---

## Security warnings

Read these before connecting a real account:

1. **`api_id` / `api_hash` are public in the bundle.** A browser-only MTProto app cannot hide them. Create a dedicated app at [my.telegram.org](https://my.telegram.org) for TGDrive; do not reuse the credentials of another client.
2. **A session string grants full account access.** It is stored in `localStorage` on this device. Avoid shared/borrowed machines, and use **Sign out** when done. Anyone with the string can act as you until it is revoked in Telegram → Settings → Devices.
3. **Telegram still sees traffic metadata.** It sees encrypted blobs, their sizes, timing, and the forum topic (folder) they land in. It does not see plaintext file contents or file names (once the file index lands).
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

| Command           | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `npm run dev`     | Vite dev server on `:5173`                                                                        |
| `npm run build`   | Production build into `dist/`                                                                     |
| `npm run preview` | Serve the production build                                                                        |
| `npm run lint`    | ESLint (flat config, Vue + JS)                                                                    |
| `npm run format`  | Prettier                                                                                          |
| `npm run smoke`   | Build, then headless-Chrome checks: login renders, route guard redirects, no fatal console errors |

The smoke test is hermetic: it maps `*.telegram.org` to localhost so it never touches the real network.

---

## Vault (`/vault`)

The vault is the recovery layer. It is created once per drive and can be opened from any device signed into the same Telegram account.

1. **Create** — choose a passphrase (12+ characters). A random 256-bit master key is generated, wrapped with an Argon2id-derived KEK, and uploaded as `v.bin` into `#index`. The raw key exists only in memory.
2. **Unlock** — the envelope is downloaded from Telegram, the KEK is re-derived from the passphrase, and the GCM tag proves the passphrase and drive id. Wrong passphrases fail without leaking anything.
3. **Lock** — drops the master key from memory. A page reload always starts locked.
4. **Forget this device** — clears local pointers only. The group, topics, vault and every chunk stay in Telegram; signing in again re-discovers the drive by its `tgdrive:` marker.

The envelope is plaintext JSON containing only public parameters (`v`, `driveId`, KDF settings, salt, timestamps) and the base64 wrapped key. Passphrases and raw keys never leave the browser.

**There is no recovery.** If the passphrase is lost, the wrapped key cannot be opened and the files are unreadable.

---

## Drive UI (`/drive`, M2 slice)

- **Folders ↔ topics:** folders are Telegram forum topics (names visible as topic titles). Reserved topics `#index` and `#trash` are hidden from the folder list.
- **Upload:** requires an unlocked vault. Each file (≤200 MB, one at a time) is chunked, encrypted per chunk with a key derived from the master key (`HKDF-SHA-256`, `file-v1:<fileId>`), and uploaded as opaque documents.
- **Manifest:** an encrypted manifest (`tgm1:<fileId>`) is stored in the same folder topic with file metadata and chunk references. The drive view scans folder messages for manifests and decrypts them locally to list files.
- **Actions:** download (reassembles + verifies hashes) and delete (removes chunks and manifest). No encrypted global index/snapshot, search, previews, trash/retention, or resumable uploads yet.

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
    vault/format.js       vault envelope + reserved names
    vault/vault.js        create / rewrap / unlock (Argon2id + AES-GCM)
    drive/manifest.js     encrypted per-file manifest format
    drive/files.js        upload/list/download/delete for topic files
    telegram/session.js   session string persistence
    telegram/topics.js    group, forum topic, message, upload helpers
    telegram/drive.js     drive discovery + vault read/write in #index
    telegram/roundtrip.js M0 encrypt → upload → download → verify pipeline
  stores/auth.js          GramJS client lifecycle, QR/phone auth
  stores/vault.js         vault lifecycle; master key in module scope only
  stores/drive.js         folders/topics, upload queue, file listing/actions
  views/                  Login, Drive, Vault, Spike lab, 404
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

| Milestone | Scope                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| **M0**    | MTProto login, group/topic lifecycle, encrypted chunk round-trip — **done**            |
| **M1**    | Passphrase-derived vault, master key wrap/unwrap, cross-device recovery — **done**     |
| **M2**    | Drive UI: folders ↔ topics, upload queue, chunk manifest — **basic slice done**        |
| M3        | Encrypted index snapshot + event log in `#index`, local IndexedDB cache, MiniSearch    |
| M4        | Search/filter by category (images/video/audio/documents), retry/resume, flood handling |
| M5        | Previews ≤50 MB, trash + 30-day retention, download/export                             |
| M6        | Polish: PWA/offline shell, themes, keyboard shortcuts, storage stats                   |

## Known limitations

- Drive UI is a basic M2 slice: folder/topic management and per-folder manifest scanning work, but there is no global encrypted index yet (listing scans topic messages).
- No search, previews, trash/30-day retention, or resumable/retry-heavy uploads yet.
- The M0 spike lab still uses its own ephemeral keys/path; normal uploads go through the vault-derived file keys.
- Losing the vault passphrase means the drive cannot be recovered.
- Clearing browser storage loses the session; the drive and vault are re-discovered from Telegram after signing in again.
- 200 MB per file and one upload at a time; Telegram rate limits still apply per chat.
- “Archived” means the group is placed in your client's Archive folder; the app never deletes the group.
- Telegram channel/supergroup limits and account restrictions can change without notice.
- Low-severity npm advisories exist in the dev-only `vite-plugin-node-polyfills` dependency tree; production dependencies audit clean.

## License

Private / unlicensed unless a license is added before publishing.
