# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Obsidian community plugin ("Git Sync") that syncs a vault across devices by committing it to the user's own private GitHub repo. Runs on desktop **and** mobile (iOS/Android), so all git and HTTP work goes through pure-JS/Obsidian APIs — no native binaries, no Node `fs`, no `fetch`.

## Commands

```bash
npm install
npm run dev      # esbuild watch mode — rebuilds main.js on save (inline sourcemaps)
npm run build    # production build — minified, no sourcemaps
```

There is **no test suite, linter, or typecheck script**. `tsconfig.json` is used by esbuild for transpile only (`isolatedModules`, no `tsc` emit step). Verify changes by loading the built `main.js` in an Obsidian vault.

The build entry is `src/main.ts` → bundled to `main.js` (git-ignored). To test in Obsidian, copy/symlink `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/git-obsi-sync/`.

Releases are tag-triggered: pushing a git tag runs `.github/workflows/release.yml`, which builds and attaches `main.js` + `manifest.json` to a GitHub Release.

## Hard mobile constraints (do not break these)

- **All HTTP must use Obsidian's `requestUrl`** (from the `obsidian` module), never `fetch`/`axios`. This is what makes mobile + CORS work. See `src/github/api.ts`, `src/auth/github-device.ts`, and the custom `gitHttp` client in `src/sync/git-sync.ts`.
- **All filesystem access must go through the Obsidian `DataAdapter`**, never Node `fs`. `src/sync/fs-adapter.ts` wraps the adapter into the `fs.promises`-shaped object isomorphic-git expects, and is the *only* place that bridges the two worlds.
- `esbuild.config.mjs` marks `obsidian`, `electron`, all `@codemirror/*`/`@lezer/*`, and Node builtins as `external` — don't import anything that pulls a Node builtin into the runtime path.

## Architecture

Layered, with `main.ts` (the `Plugin` subclass) as the only orchestrator. Lower layers never import `main.ts` or touch Obsidian settings.

- **`src/main.ts`** — plugin lifecycle. Registers vault `modify`/`create`/`delete`/`rename` events → `SyncQueue`; pulls on `onLayoutReady`; flushes the queue on `onunload`; owns the connect/disconnect flow and conflict-modal wiring. `isExcluded()` compiles the user's glob-ish `excludePatterns` (only `*` is special) to regex.
- **`src/sync/git-sync.ts`** — `GitSync`, the isomorphic-git wrapper. Owns the full sync cycle: stage → commit-if-dirty → fetch → merge → detect conflicts → push. Every step is individually try/guarded so one failure (e.g. offline fetch) doesn't cascade. `gitOpts()` vs `netOpts()` split matters: network ops need `onAuth` (isomorphic-git strips creds from the URL) and an explicit `url`.
- **`src/sync/queue.ts`** — `SyncQueue`. Debounces file events (`SYNC_DEBOUNCE_MS`, 3s), coalesces into a `Set`, runs one sync at a time (`running` guard), and re-flushes if changes arrived mid-sync.
- **`src/sync/fs-adapter.ts`** — the Obsidian-adapter → isomorphic-git `fs` bridge. isomorphic-git passes **absolute** paths; `rel()` strips the vault base path before calling the adapter (which wants relative paths). On mobile `basePath` is undefined, so paths stay relative.
- **`src/sync/conflict.ts`** — pure line-diff helper for the conflict modal.
- **`src/auth/github-device.ts`** — GitHub OAuth **Device Flow** (no backend server): request a device code, poll the token endpoint honoring `authorization_pending`/`slow_down`.
- **`src/github/api.ts`** — REST calls: get user, check/create the private repo, derive repo name (`obsidian-<slugified-vault-name>`).
- **`src/ui/`** — `settings-tab.ts` (connect flow + options), `status-bar.ts` (clickable status → manual sync), `conflict-modal.ts` (side-by-side keep-mine/keep-theirs).

### Sync-state model to keep in mind

Three distinct states, checked in `initializeRepo` and throughout `GitSync`:
1. `isInitialized()` — local `.git` with a resolvable `HEAD`.
2. `hasLocalBranch()` — `refs/heads/main` exists (≥1 commit; distinguishes an unborn branch after `git.init`).
3. remote existence (`repoExists`) and remote emptiness (`clone()` returns `false` when the remote has no commits).

The initial-push/clone/reconnect branching in `initializeRepo` and the retry-safety in `initAndPush` exist to handle interrupted first pushes (repo created but never pushed). Preserve these guards when editing.

`DEFAULT_BRANCH` is `"main"` and the code assumes a single branch everywhere (`singleBranch: true`). There is no rebase — merges are real merge commits via `git.merge`.

## Gotchas

- **CLIENT_ID is injected at build time, not hardcoded.** `esbuild.config.mjs` loads `.env` via `dotenv` and injects `CLIENT_ID` into the bundle with a `define` for `process.env.CLIENT_ID`; `src/constants.ts` reads `process.env.CLIENT_ID`. A real exported env var (CI secret) wins over `.env`. A **production** build (`npm run build`) fails fast if `CLIENT_ID` is empty; a **dev** build (`npm run dev`) is allowed to run without it. To change the OAuth app, edit `.env` (local) or the CI secret — never hardcode it in source. The authorization screen's app name/owner is determined entirely by this `CLIENT_ID`.
- **Naming is inconsistent.** `package.json`/`PLUGIN_ID`/esbuild banner say `obsidian-multisync`; `manifest.json` id is `git-obsi-sync` (this is the folder name Obsidian uses under `.obsidian/plugins/`, and it must match the manifest id or the plugin fails to load). User-facing name is "Git Sync". Don't "fix" one without checking the others.
- `excludePatterns` matching supports only `*` as a wildcard (converted to `.*`), anchored full-match — not full glob. Default excludes `.obsidian/workspace*` and per-plugin `data.json`.
