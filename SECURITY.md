# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in TGDrive, please report it responsibly.

- **Do not** open a public GitHub issue for security vulnerabilities.
- Use GitHub's private vulnerability reporting for this repository if it is enabled.
- If private reporting is not available, contact the maintainer directly with enough detail to reproduce and assess the issue.

Please include:

- A description of the vulnerability and potential impact
- Steps to reproduce or a proof of concept (if possible)
- Affected versions/commit(s) and environment details
- Any suggested mitigation

## Scope and notes

TGDrive is a client-side application that stores encrypted data in Telegram and keeps sensitive material (sessions, keys in memory/unlock cache behavior as implemented) in the browser environment.

Important considerations:

- Telegram API credentials (`VITE_TG_API_ID` / `VITE_TG_API_HASH`) are embedded in client builds by design for this architecture.
- MTProto session strings grant account access; protect local devices and revoke sessions when needed.
- Telegram can observe traffic metadata (sizes, timing, topics), even when file contents/metadata are encrypted.
- Losing the vault passphrase means encrypted data cannot be recovered.
- This project is provided as-is and should not be treated as a guaranteed backup solution.

## Supported versions

Security fixes are provided on a best-effort basis for the latest state of the default branch.
