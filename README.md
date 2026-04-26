# Codex Companion

Codex Companion is a local-first issue and snag-list app for Codex-managed projects.

The first screen is the working companion layout:

- project sidebar aligned to local Codex project paths
- central issue list with date/time, title, file, source, category, and status
- Codex Queue and User Added views across active projects
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
npm run dist:dir
npm run dist:win
```

`npm run dist:dir` creates an unpacked app in `release/` for a fast packaging sanity check. `npm run dist:win` creates the Windows installer and portable build. The installer is named Codex Companion, creates Start Menu and desktop shortcuts, and preserves `%APPDATA%/Codex Companion` on uninstall so local issue data is not deleted accidentally.

The desktop app uses `Codex Companion` as its installed app name. On Windows, the default data store is `%APPDATA%/Codex Companion`.

On first launch, the app shows a setup screen with three choices:

- create starter local issue data in the default store
- connect an existing folder that contains `issues/projects.json`
- clone a GitHub issue-data repository into the default store

The selected issue-data root is saved in `%APPDATA%/Codex Companion/config.json`, so the workspace and Git repository can stay named `issue-management` while the installed app and default store use `Codex Companion`.

After setup, the sidebar shows the active issue-data folder and the GitHub sync panel lets users connect a remote URL. For starter local data, Codex Companion can initialise Git in that issue-data folder, set `origin`, and use the normal Sync/Push controls from then on.

## Codex Intake CLI

The CLI writes to the same JSON files as the app.

```bash
node bin/issue-manager.js root

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

The CLI resolves issue data in this order: `ISSUE_ROOT_DIR`, the saved Codex Companion config in `%APPDATA%/Codex Companion/config.json`, then the repository-local `issues/` folder. That lets Codex write to the same issue store selected by the desktop app.

Categories are `bug`, `snag`, `feature`, `refactor`, `docs`, `testing`, and `question`. User-created items default to `snag`, which signals that Codex should look for an appropriate opportunity to handle it without derailing the active task.

## Integration Direction

The intended integration is local-first:

- issues are stored in deterministic JSON files under an `issues/` folder
- the React app reads and writes issues through the local `/api` service
- Codex will record findings through a local `issue-manager` CLI/API
- GitHub sync pulls before local edits and pushes committed issue-file changes afterward

See [docs/codex-github-integration.md](docs/codex-github-integration.md) for the proposed storage shape, Codex intake command, and sync contract.
