# CLAUDE.md

## Project Overview

Labric Sync is a Tauri 2 desktop app that watches a local folder and uploads file changes to the Labric platform. React 19 + TypeScript frontend, Rust backend.

## Commands

```bash
pnpm install              # Install frontend dependencies
pnpm tauri dev            # Run dev (Vite on :1420 + Tauri window)
pnpm tauri build          # Production build
pnpm types                # Generate TS types from OpenAPI spec
pnpm test                 # Run frontend unit tests (Node test runner)
cargo check --manifest-path src-tauri/Cargo.toml   # Check Rust code
cargo clippy --manifest-path src-tauri/Cargo.toml   # Lint Rust code
```

## Architecture

- **Frontend** (`src/`): React 19, TanStack Router (file-based), Tailwind v4, shadcn/ui
- **Backend** (`src-tauri/src/`): Rust, Tauri 2, tokio async runtime
- **IPC**: Frontend calls Rust via `invoke()` commands; Rust pushes to frontend via `emit()` events
- **Key Rust modules**: `lib.rs` (commands + file watcher), `upload.rs` (queue processor), `heartbeat.rs` (30s heartbeat loop)
- **Auth**: JWT tokens stored in Tauri Store, pairing via 6-digit device code flow

## Tauri v2 Docs

**Tauri v2 docs:** https://v2.tauri.app/llms.txt -- always reference this for Tauri APIs, plugins, and patterns. This project uses Tauri v2, not v1.

## Code Style

- **Rust**: Standard Rust conventions. Use `tokio` for async. State is `Arc<Mutex<T>>` managed via Tauri `manage()`.
- **TypeScript**: ESM modules, path alias `@/` maps to `src/`. Use shadcn/ui components from `@/components/ui/`.
- **CSS**: Tailwind v4 utility classes. No separate CSS modules.

## Key Patterns

- File watcher uses the `notify` crate (native OS events, not polling)
- Uploads are batched (max 1000/batch) with presigned URLs from `/api/sync/upload-urls`
- CRC32C hashes (base64, big-endian) are used for file deduplication
- Frontend listens to Rust events: `file_change`, `upload_progress`, `upload_success`, `upload_failed`, `file_upload_status`, `heartbeat_status`
- Protected routes live under `src/routes/_protected/`

## Environment

- Requires the Labric platform backend running -- `http://localhost:3000` for dev, `https://platform.labric.co` in prod
- `VITE_SERVER_URL` -- API base URL (set in `.env.local` / `.env.production`)
- Version is tracked in three places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` -- keep them in sync

## CI/CD

- Every new PR must bump the version (patch bump unless told otherwise) in all three places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
- GitHub Actions on push to `main` builds for macOS (x86_64 + aarch64), Linux, Windows
- Builds are code-signed (Apple notarization + DigiCert for Windows)
- Auto-updates via Tauri updater plugin pulling from GitHub Releases

## Gotchas

- Test coverage is thin (Rust tests in `src-tauri/tests/`, a few frontend unit tests run by `pnpm test`) -- be careful with refactors
- `tauri.conf.json` CSP is set to `null` (permissive) -- do not tighten without testing
- The upload queue runs as a background tokio task started in `setup()` -- it's always running when the app is open
- Tauri Store persists to `settings.json` in the app data directory, not the project
