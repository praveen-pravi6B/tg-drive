# TGDrive

TGDrive is an encrypted, serverless cloud drive that stores files in **your own private Telegram forum supergroup**. It runs as a client-side SPA (Vue 3 + Vite + GramJS): no backend, no database, and no separate account system — the browser talks directly to Telegram over MTProto.

> **Status:** development build / work in progress. Not a backup product.

## Features

- **Telegram-backed storage:** one private forum supergroup per user (auto-discovered/created, archived, forwarding disabled where possible)
- **Client-side encryption:** chunked AES-256-GCM uploads with per-file keys derived via HKDF-SHA-256 from a vault master key
- **Vault & recovery:** passphrase-derived vault (Argon2id) with encrypted recovery stored in Telegram (`#index`), unlock/lock flow
- **Folders ↔ topics:** Telegram forum topics map to folders (reserved topics like `#index` hidden; "General" shown as Home)
- **Drive UI:** grid/list views, previews (image/PDF/audio/video), thumbnails, multi-select, copy/cut/paste, copy file link, queued uploads
- **Search & filters:** in-folder and global search across folders (MiniSearch) with category filters
- **Caching:** encrypted index snapshot cached in IndexedDB for faster load/fallback, plus 1-day decrypted media cache
- **Trash & retention:** soft delete to Trash, restore, permanent delete, empty trash, and 30-day auto-purge (including trashed folders)
- **Resilience:** flood-wait handling and per-chunk retry/backoff for uploads/downloads/key Telegram operations; resumable-across-refresh uploads by re-selecting the same file
- **Event trail:** encrypted event entries appended in `#index` and a recent event trail kept in the encrypted index snapshot

## How it works

- **Storage model:** files are split into chunks, encrypted in the browser, and uploaded as documents in folder topics. An encrypted per-file manifest stores metadata/chunk references. An encrypted index snapshot (`i.bin` in `#index`) caches folder/file metadata for faster loading.
- **Key model:** a random 256-bit master key is wrapped by an Argon2id-derived KEK (vault envelope in `#index`) and used to derive per-file keys (`HKDF-SHA-256`, `file-v1:<fileId>`). Chunks are encrypted with AES-256-GCM (12-byte nonce, AAD bound to file/chunk).
- **Privacy/security boundary:** file contents and sensitive metadata are encrypted client-side, but Telegram can still observe traffic metadata (encrypted blob sizes, timing, topics/folder placement).

## Requirements

- Node.js 22+
- npm 10+
- Chromium-based browser recommended

## Getting started

### 1. Install

```bash
git clone <your-repo-url> tg-drive
cd tg-drive
npm install
```

### 2. Configure Telegram API credentials

Create an app at [my.telegram.org](https://my.telegram.org) (**API development tools → App configuration**) and set credentials in `.env.local`:

```bash
cp .env.example .env.local
```

```dotenv
VITE_TG_API_ID=12345678
VITE_TG_API_HASH=0123456789abcdef0123456789abcdef

# Optional
VITE_TG_CHUNK_SIZE=20971520
```

If no env credentials are configured, the app can prompt for them and store them locally in the browser.

### 3. Run

```bash
npm run dev
```

Open the printed URL and sign in via QR (**Telegram → Settings → Devices → Link Desktop Device**) or phone/2FA fallback.

## Scripts

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `npm run dev`     | Start Vite dev server               |
| `npm run build`   | Production build to `dist/`         |
| `npm run preview` | Preview production build            |
| `npm run lint`    | Run ESLint                          |
| `npm run format`  | Format with Prettier                |
| `npm run smoke`   | Build and run headless smoke checks |

## Deployment (Cloudflare Pages)

TGDrive is a static SPA and can be deployed to Cloudflare Pages:

- **Framework preset:** None / Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node.js version:** 22

Set environment variables for Production/Preview:

- `VITE_TG_API_ID`
- `VITE_TG_API_HASH`

The repo includes SPA fallback/headers (`public/_redirects`, `public/_headers`) and a GitHub Actions build workflow (`.github/workflows/build.yml`).

## Project structure

```text
src/
  main.js, polyfills.js
  lib/
    config.js, logger.js, utils.js
    crypto/        # bytes, kdf, chunk/worker helpers
    vault/         # vault format and unlock/wrap logic
    drive/         # manifests, file ops, index, caches, event log, upload sessions
    telegram/      # session, topics, drive/index/event helpers
  stores/          # auth, vault, drive state
  views/           # Login, Drive, Vault, NotFound
  components/ui/   # UI primitives
  workers/         # crypto worker
```

## Security notes

- **Client-exposed API credentials:** Telegram `api_id`/`api_hash` are present in browser builds by design for this architecture; use a dedicated Telegram app.
- **Session sensitivity:** MTProto session data stored in browser storage grants account access until revoked; avoid shared devices and sign out when needed.
- **Metadata visibility:** Telegram can observe encrypted blob sizes, timing, and topic/folder placement.
- **No passphrase recovery:** losing the vault passphrase means encrypted data cannot be recovered.
- **Unofficial client / limits:** automated use may trigger Telegram rate limits or restrictions; keep another copy of important data.

Please report vulnerabilities responsibly — see [SECURITY.md](SECURITY.md).

## Limitations

- 200 MB max file size; uploads processed sequentially (queue)
- Telegram rate limits/restrictions and data availability are outside app control
- Clearing browser storage removes local caches/session state (drive/vault are rediscovered from Telegram after sign-in)
- Resumable uploads require re-selecting the same file (name/size/last modified) in the same folder to continue
- Development build; behavior and data formats may evolve

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
