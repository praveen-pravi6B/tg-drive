# Contributing to TGDrive

Thanks for your interest in contributing to TGDrive.

## Before you start

- Please open an issue or discussion for significant changes before starting work.
- Keep changes focused and aligned with the project's goals: a client-side encrypted, serverless drive backed by Telegram.
- Do not include secrets, personal Telegram credentials, session strings, or private data in issues, commits, or pull requests.

## Development setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure Telegram API credentials in `.env.local` (see `.env.example`).
4. Start the dev server:
   ```bash
   npm run dev
   ```

## Useful scripts

- `npm run dev` — start the development server
- `npm run build` — production build
- `npm run lint` — run ESLint
- `npm run format` — format source files
- `npm run smoke` — build and run smoke checks

## Pull requests

- Use clear, descriptive commit messages.
- Run `npm run lint` and `npm run build` before submitting when applicable.
- Update documentation (`README.md`, etc.) for user-facing or behavior changes.
- Describe what changed, why, and how it was tested (include screenshots/GIFs for UI changes when helpful).

## Security issues

Please do **not** report security vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for reporting guidance.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
