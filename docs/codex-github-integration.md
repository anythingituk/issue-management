# Codex and GitHub Integration Contract

The app should stay local-first. GitHub is the transport between machines, and Codex writes issues through a small local interface instead of needing direct access to the UI.

## Issue Storage

Recommended storage layout:

```text
issues/
  projects.json
  issue-management.json
  client-portal.json
```

Each project issue file should be deterministic JSON so Git diffs stay readable.

```json
{
  "projectId": "issue-management",
  "issues": [
    {
      "id": "iss-20260426-061800",
      "createdAt": "2026-04-26T06:18:00+01:00",
      "title": "Create Codex issue intake command",
      "file": "tools/codex-issue.ts",
      "status": "in-progress",
      "category": "feature",
      "source": "Codex",
      "detail": "Codex needs a direct command/API path for recording discovered issues.",
      "activity": ["Codex identified the integration boundary."]
    }
  ]
}
```

## Codex Intake

Codex should be able to add or update an issue without opening the UI.

```bash
npm run issue -- add \
  --project /mnt/c/dev/issue-management \
  --title "Persist issues in Git-friendly files" \
  --file "issues/issue-management.json" \
  --category feature \
  --source Codex
```

Implemented commands:

- `issue-manager add`
- `issue-manager status`
- `issue-manager activity`
- `issue-manager list`
- `issue-manager root`

The intake CLI resolves issue data in this order:

- `ISSUE_ROOT_DIR`
- the saved Codex Companion desktop config in `%APPDATA%/Codex Companion/config.json`
- the repository-local `issues/` folder

Supported categories:

- `bug`
- `snag`
- `feature`
- `refactor`
- `docs`
- `testing`
- `question`

`snag` is the user-facing category for small future tweaks. When a snag is added, Codex should check whether the active task already touches the relevant area and either address it opportunistically or leave it queued.

Planned commands:

- `issue-manager sync pull`
- `issue-manager sync push`

## GitHub Sync

The app should pull before editing and push after local issue changes.

Implemented API endpoints:

- `POST /api/projects`
- `PATCH /api/projects/:id`
- `GET /api/queue`
- `GET /api/sync/status`
- `POST /api/sync/pull`
- `POST /api/sync/push`
- `POST /api/sync/all`

`POST /api/projects` appends to `issues/projects.json` and creates the matching empty project issue file.
`PATCH /api/projects/:id` updates project name, path, branch, and archived state while preserving the id and issue file.
`GET /api/queue` returns non-fixed issues across active projects for the Codex Queue and User Added views.

The push endpoint stages only `issues/`, commits with `Update issue list`, and then runs `git push`.

The combined sync endpoint stages and commits issue-file changes first, pulls with rebase, and then pushes. This protects local issue edits before integrating remote changes.

```bash
git pull --rebase
git add issues/
git commit -m "Update issue list"
git push
```

Conflict handling should prefer preserving both edits. If two machines add different issues, both should remain. If two machines edit the same issue, the app should show a conflict review state rather than silently choosing a winner.

## Desktop Packaging

Electron groundwork is present:

- `electron/main.mjs` starts the local API internally.
- The installed app name is `Codex Companion`.
- The Windows data store is `%APPDATA%/Codex Companion`.
- On first desktop launch, users can create starter data, connect an existing issue-data folder, or clone a GitHub issue-data repo.
- The active issue-data folder is saved in `%APPDATA%/Codex Companion/config.json`.
- The desktop app can initialise Git for starter data and connect or update the GitHub `origin` remote.
- `npm run desktop` builds the web UI and opens it in an Electron window.
- `npm run dist:win` creates Windows targets through `electron-builder`.

## AGENTS.md Convention

Each Codex-managed project can include this instruction:

```md
When you discover a non-blocking bug, tweak, or future work item, record it in Codex Companion using the local `issue-manager` command. Do not interrupt the current task unless the issue blocks completion.

When the user adds a `snag`, check whether the current Codex task naturally overlaps with that snag. If it does, consider working on it in the same session; if it does not, leave it queued for later.
```
