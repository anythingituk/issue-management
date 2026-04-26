# Codex Companion Windows Guide

This guide is for installing and using Codex Companion on Windows.

## Requirements

- Windows 10 or later.
- Git for Windows if you want GitHub sync from inside the app.
- A GitHub repository for shared issue data if you want to use the app on more than one machine.

## Install

Download the latest Windows installer or portable executable from GitHub Releases.

The installer creates Start Menu and desktop shortcuts named `Codex Companion`. It does not remove local issue data on uninstall.

## First Launch

Codex Companion stores its own settings in:

```text
%APPDATA%/Codex Companion
```

On first launch, choose one setup option:

- `Starter local data`: creates a fresh local issue store.
- `Existing folder`: connects a folder that already contains `issues/projects.json`.
- `GitHub issue repo`: clones a Git-backed issue-data repository.

The selected issue-data root is saved in:

```text
%APPDATA%/Codex Companion/config.json
```

## GitHub Sync

For starter local data, paste your GitHub remote URL into the GitHub Sync panel and select `Connect`.

Codex Companion can initialise Git in the issue-data folder, set the `origin` remote, and then use the normal `Sync`, `Pull`, and `Push` buttons.

SSH remotes such as `git@github.com:user/repo.git` require Git for Windows and a configured SSH key. HTTPS remotes may prompt through Git Credential Manager.

## Multi-Machine Use

Use the same GitHub issue-data repository on each machine.

Recommended setup:

1. Install Codex Companion on the first PC.
2. Choose `Starter local data`.
3. Connect the GitHub remote and `Push`.
4. Install Codex Companion on the second PC.
5. Choose `GitHub issue repo` and clone the same repository.

After that, use `Sync` before and after changes so each machine stays up to date.

## Codex Link

Codex can add issues through the included `issue-manager` CLI. The CLI uses the same issue-data folder selected in the desktop app when it can find `%APPDATA%/Codex Companion/config.json`.

To check where the CLI will write:

```bash
node bin/issue-manager.js root
```

## Data Safety

Issue data is stored as JSON files under an `issues/` folder. The app commits only `issues/` during push/sync operations.

The installer preserves `%APPDATA%/Codex Companion` on uninstall so local settings and issue data are not deleted accidentally.
