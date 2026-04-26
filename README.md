# Codex Companion

Codex Companion is a local-first issue and snag-list app for Codex-managed projects.

The first screen is the working companion layout:

- project sidebar aligned to local Codex project paths
- central issue list with date/time, title, file, source, category, and status
- detail inspector with notes, category, status controls, and Codex activity
- quick-add flow for user-created future requests
- sidebar flow for adding local Codex projects
- visible GitHub pull/push sync controls

## Run

```bash
npm install
npm run api
npm run dev:app
```

Run the API and app commands in separate terminals during development.

## Build

```bash
npm run build
```

## Desktop App

Electron groundwork is included. The desktop app starts the local API internally and opens the built React UI in an app window.

```bash
npm run desktop
```

Windows packaging:

```bash
npm run dist:win
```

The desktop app uses `Codex Companion` as its installed app name. On Windows, the default data store is `%APPDATA%/Codex Companion`. On first launch, the app creates that folder and seeds its `issues/` data from the bundled starter files if no issue data exists yet.

A later first-run setup should let installed users choose or clone their own Git-backed issue data folder into that default store.

## Codex Intake CLI

The CLI writes to the same JSON files as the app.

```bash
node bin/issue-manager.js add \
  --project /mnt/c/dev/issue-management \
  --title "Button text overflows on mobile" \
  --file src/App.css \
  --category bug \
  --source Codex

node bin/issue-manager.js status --id iss-001 --status fixed
node bin/issue-manager.js activity --id iss-001 --message "Codex started inspecting the issue."
node bin/issue-manager.js list --project /mnt/c/dev/issue-management
```

Categories are `bug`, `snag`, `feature`, `refactor`, `docs`, `testing`, and `question`. User-created items default to `snag`, which signals that Codex should look for an appropriate opportunity to handle it without derailing the active task.

## Integration Direction

The intended integration is local-first:

- issues are stored in deterministic JSON files under an `issues/` folder
- the React app reads and writes issues through the local `/api` service
- Codex will record findings through a local `issue-manager` CLI/API
- GitHub sync pulls before local edits and pushes committed issue-file changes afterward

See [docs/codex-github-integration.md](docs/codex-github-integration.md) for the proposed storage shape, Codex intake command, and sync contract.
