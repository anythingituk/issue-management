import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const port = Number(process.env.ISSUE_API_PORT ?? 8787)
const defaultRootDir = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const execFileAsync = promisify(execFile)
let configuredRootDir = process.env.ISSUE_ROOT_DIR
  ? path.resolve(process.env.ISSUE_ROOT_DIR)
  : undefined
let automationRun = null
let automationChild = null
let automationCancelRequested = false

const automationPolicies = new Set([
  'approved-or-soon',
  'approved-only',
  'soon-only',
  'codex-or-approved-user',
  'all',
])

const statusLabels = {
  open: 'Open',
  'in-progress': 'In progress',
  'ready-for-review': 'Ready for review',
  fixed: 'Fixed',
  deferred: 'Deferred',
}

const categoryLabels = {
  bug: 'Bug',
  snag: 'Snag',
  feature: 'Feature',
  refactor: 'Refactor',
  docs: 'Docs',
  testing: 'Testing',
  question: 'Question',
}

const decisionLabels = {
  approved: 'Approved',
  waiting: 'Waiting',
  ignored: 'Ignored',
}

const priorityLabels = {
  soon: 'Action soon',
  later: 'Action later',
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function getRootDir() {
  return configuredRootDir ?? defaultRootDir
}

function getDefaultDataDir() {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Codex Companion')
  }

  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Codex Companion')
  }

  if (process.env.USER && existsSync(`/mnt/c/Users/${process.env.USER}/AppData/Roaming`)) {
    return `/mnt/c/Users/${process.env.USER}/AppData/Roaming/Codex Companion`
  }

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'Codex Companion')
  }

  if (process.env.HOME) {
    return path.join(process.env.HOME, '.config', 'Codex Companion')
  }

  return defaultRootDir
}

function getDataDir() {
  return path.resolve(process.env.CODEX_COMPANION_DATA_DIR ?? getDefaultDataDir())
}

function getConfigPath() {
  return path.join(getDataDir(), 'config.json')
}

function getLegacyConfigPath() {
  return path.join(defaultRootDir, 'config.json')
}

function getIssuesDir() {
  return path.join(getRootDir(), 'issues')
}

function getProjectsPath() {
  return path.join(getIssuesDir(), 'projects.json')
}

function getBundledIssuesDir() {
  return path.join(defaultRootDir, 'issues')
}

function getCodexConfigPath() {
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'config.toml') : '',
    process.env.HOME ? path.join(process.env.HOME, '.codex', 'config.toml') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex', 'config.toml') : '',
    process.env.USER ? `/mnt/c/Users/${process.env.USER}/.codex/config.toml` : '',
  ].filter(Boolean)

  return candidates.find((candidate) => existsSync(candidate)) ?? ''
}

function hasProjectsFile(rootDir = getRootDir()) {
  return existsSync(path.join(rootDir, 'issues', 'projects.json'))
}

function loadSetupConfig() {
  const config = readAppConfig()
  if (config.issueRootDir) {
    configuredRootDir = path.resolve(String(config.issueRootDir))
    process.env.ISSUE_ROOT_DIR = configuredRootDir
  }
}

function readAppConfig() {
  const configPath = [getConfigPath(), getLegacyConfigPath()].find((candidate) => existsSync(candidate))

  if (!configPath) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    console.warn(`Unable to read Codex Companion config at ${configPath}:`, error)
    return {}
  }
}

function writeAppConfig(config) {
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}

function saveSetupConfig(rootDir) {
  const nextRootDir = path.resolve(rootDir)
  writeAppConfig({
    ...readAppConfig(),
    issueRootDir: nextRootDir,
  })
  configuredRootDir = nextRootDir
  process.env.ISSUE_ROOT_DIR = nextRootDir
}

function normalizeIssueRootDir(candidatePath) {
  const inputPath = String(candidatePath ?? '').trim()
  if (!inputPath) {
    return undefined
  }

  const resolvedPath = path.resolve(inputPath)

  if (hasProjectsFile(resolvedPath)) {
    return resolvedPath
  }

  if (existsSync(path.join(resolvedPath, 'projects.json'))) {
    return path.dirname(resolvedPath)
  }

  return undefined
}

async function readProjects() {
  return readJson(getProjectsPath())
}

function slugifyProjectId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function projectIssuePath(project) {
  return path.join(getIssuesDir(), project.issueFile ?? `${project.id}.json`)
}

function resolveProjectCwd(projectPath) {
  const rawPath = String(projectPath ?? '').trim()
  if (!rawPath) {
    return ''
  }

  if (existsSync(rawPath)) {
    return rawPath
  }

  const wslMatch = rawPath.match(/^\/mnt\/([a-z])\/(.+)$/i)
  if (wslMatch) {
    const windowsPath = `${wslMatch[1].toUpperCase()}:\\${wslMatch[2].replaceAll('/', '\\')}`
    if (existsSync(windowsPath)) {
      return windowsPath
    }
  }

  return rawPath
}

function truncateOutput(value, maxLength = 4000) {
  const output = String(value ?? '').trim()
  if (output.length <= maxLength) {
    return output
  }

  return `${output.slice(0, maxLength)}\n...output truncated...`
}

function formatAutomationChangedFiles(statusOutput, project) {
  const issueFilePath = `issues/${project.issueFile ?? `${project.id}.json`}`
  return String(statusOutput ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const changedPath = line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim().split(' -> ').pop().replaceAll('\\', '/')
      return changedPath !== issueFilePath
    })
    .join('\n')
}

async function readProjectIssues(project) {
  try {
    const issueFile = await readJson(projectIssuePath(project))
    return Array.isArray(issueFile.issues)
      ? issueFile.issues.map((issue) => ({
          ...issue,
          decision: issue.decision && decisionLabels[issue.decision] ? issue.decision : 'waiting',
          priority: issue.priority && priorityLabels[issue.priority] ? issue.priority : 'later',
        }))
      : []
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function writeProjectIssues(project, issues) {
  await writeJson(projectIssuePath(project), {
    projectId: project.id,
    issues,
  })
}

async function updateIssueRecord(issueId, updater) {
  const projects = await readProjects()

  for (const project of projects) {
    const issues = await readProjectIssues(project)
    const issueIndex = issues.findIndex((issue) => issue.id === issueId)

    if (issueIndex === -1) {
      continue
    }

    const nextIssue = updater(issues[issueIndex], project)
    const nextIssues = [...issues]
    nextIssues[issueIndex] = nextIssue
    await writeProjectIssues(project, nextIssues)
    return { issue: nextIssue, project }
  }

  return undefined
}

async function readRequestJson(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : {}
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message })
}

async function createSshAskpassEnv(sshPassphrase) {
  const passphrase = String(sshPassphrase ?? '')
  if (!passphrase) {
    return { cleanup: async () => {}, env: process.env }
  }

  const askpassDir = await mkdtemp(path.join(tmpdir(), 'codex-companion-askpass-'))
  const askpassPath = path.join(askpassDir, 'ssh-askpass.sh')
  await writeFile(
    askpassPath,
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_COMPANION_SSH_PASSPHRASE"\n',
    'utf8',
  )
  await chmod(askpassPath, 0o700)

  return {
    cleanup: async () => {
      await rm(askpassDir, { force: true, recursive: true })
    },
    env: {
      ...process.env,
      CODEX_COMPANION_SSH_PASSPHRASE: passphrase,
      DISPLAY: process.env.DISPLAY || ':0',
      GIT_TERMINAL_PROMPT: '0',
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
    },
  }
}

async function runGit(args, options = {}) {
  const askpass = await createSshAskpassEnv(options.sshPassphrase)
  try {
    const result = await execFileAsync('git', args, {
      cwd: getRootDir(),
      env: askpass.env,
      timeout: options.timeout ?? 30000,
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim()
    return {
      ok: false,
      output,
    }
  } finally {
    await askpass.cleanup()
  }
}

async function runGitIn(cwd, args, timeout = 30000) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout,
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim()
    return {
      ok: false,
      output,
    }
  }
}

function getSetupState() {
  return {
    configured: hasProjectsFile(),
    dataDir: getDataDir(),
    issuesDir: getIssuesDir(),
    rootDir: getRootDir(),
  }
}

function setupStatus(response) {
  sendJson(response, 200, getSetupState())
}

function setupStarter(response) {
  const targetRootDir = getDataDir()
  const targetProjectsPath = path.join(targetRootDir, 'issues', 'projects.json')

  if (existsSync(targetProjectsPath)) {
    saveSetupConfig(targetRootDir)
    sendJson(response, 200, {
      ...getSetupState(),
      message: 'Using existing starter issue data.',
    })
    return
  }

  mkdirSync(targetRootDir, { recursive: true })
  cpSync(getBundledIssuesDir(), path.join(targetRootDir, 'issues'), {
    recursive: true,
    errorOnExist: false,
    force: false,
  })
  saveSetupConfig(targetRootDir)
  sendJson(response, 201, {
    ...getSetupState(),
    message: 'Starter issue data created.',
  })
}

async function setupExisting(response, request) {
  const body = await readRequestJson(request)
  const selectedRootDir = normalizeIssueRootDir(body.path)

  if (!selectedRootDir) {
    sendError(response, 400, 'Choose a folder that contains issues/projects.json.')
    return
  }

  saveSetupConfig(selectedRootDir)
  sendJson(response, 200, {
    ...getSetupState(),
    message: 'Existing issue data connected.',
  })
}

async function setupClone(response, request) {
  const body = await readRequestJson(request)
  const remoteUrl = String(body.remoteUrl ?? '').trim()

  if (!remoteUrl) {
    sendError(response, 400, 'GitHub repository URL is required.')
    return
  }

  const dataDir = getDataDir()
  const targetRootDir = path.join(dataDir, 'issue-repository')
  mkdirSync(dataDir, { recursive: true })

  if (existsSync(targetRootDir) && readdirSync(targetRootDir).length > 0) {
    sendError(response, 409, `${targetRootDir} already exists and is not empty.`)
    return
  }

  const clone = await runGitIn(dataDir, ['clone', remoteUrl, targetRootDir], 120000)
  if (!clone.ok) {
    sendError(response, 409, clone.output || 'Git clone failed.')
    return
  }

  if (!hasProjectsFile(targetRootDir)) {
    sendError(response, 400, 'The cloned repository does not contain issues/projects.json.')
    return
  }

  saveSetupConfig(targetRootDir)
  sendJson(response, 201, {
    ...getSetupState(),
    message: 'GitHub issue repository cloned and connected.',
    output: clone.output,
  })
}

async function syncStatus(response) {
  const status = await runGit(['status', '--short'])
  const branch = await runGit(['branch', '--show-current'])
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const divergence = upstream.ok ? await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD']) : undefined
  const remote = await runGit(['config', '--get', 'remote.origin.url'])

  if (!status.ok) {
    sendJson(response, 200, {
      checkedAt: new Date().toISOString(),
      ready: false,
      message: 'Codex Companion is not connected to a git repository yet.',
      output: status.output,
      remoteUrl: remote.ok ? remote.output : '',
    })
    return
  }

  const [behind = 0, ahead = 0] =
    divergence?.ok && divergence.output
      ? divergence.output.split(/\s+/).map((value) => Number(value))
      : []
  const message = status.output
    ? 'Local issue changes are waiting to be pushed.'
    : ahead
      ? `${ahead} local commit${ahead === 1 ? '' : 's'} waiting to be pushed.`
      : behind
        ? `${behind} remote commit${behind === 1 ? '' : 's'} waiting to be pulled.`
        : upstream.ok
          ? 'Working tree is clean and connected to GitHub.'
          : 'Working tree is clean. Set an upstream before syncing.'

  sendJson(response, 200, {
    ahead,
    behind,
    branch: branch.ok ? branch.output : '',
    checkedAt: new Date().toISOString(),
    dirty: Boolean(status.output),
    ready: true,
    message,
    output: status.output,
    remoteUrl: remote.ok ? remote.output : '',
    upstream: upstream.ok ? upstream.output : '',
  })
}

async function syncHistory(response) {
  const remote = await runGit(['config', '--get', 'remote.origin.url'])
  const status = await runGit(['status', '--short'])
  const log = await runGit([
    'log',
    '--max-count=8',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%ad%x1f%s',
  ])

  const events = []

  if (status.ok && status.output) {
    const changedFiles = status.output.split('\n')
    events.push({
      id: 'working-tree',
      createdAt: new Date().toISOString(),
      detail: `${changedFiles.length} local file change${
        changedFiles.length === 1 ? '' : 's'
      } waiting for sync`,
      status: 'Pending',
      title: 'Local issue changes',
      type: 'working-tree',
    })
  }

  if (log.ok && log.output) {
    for (const line of log.output.split('\n')) {
      const [hash, shortHash, createdAt, title] = line.split('\x1f')
      if (!hash || !shortHash || !createdAt || !title) {
        continue
      }

      events.push({
        id: hash,
        createdAt,
        detail: shortHash,
        shortHash,
        status: 'Committed',
        title,
        type: 'commit',
      })
    }
  }

  sendJson(response, 200, {
    checkedAt: new Date().toISOString(),
    events,
    remoteUrl: remote.ok ? remote.output : '',
  })
}

async function syncPull(response, request) {
  const body = await readRequestJson(request)
  const gitOptions = { sshPassphrase: body.sshPassphrase }
  const result = await runGit(['pull', '--rebase'], gitOptions)

  if (!result.ok) {
    sendError(response, 409, result.output || 'Git pull failed.')
    return
  }

  sendJson(response, 200, {
    message: result.output || 'Pulled latest issue data from GitHub.',
    output: result.output,
  })
}

async function commitIssueChanges() {
  const add = await runGit(['add', 'issues/'])
  if (!add.ok) {
    return { committed: false, ok: false, output: add.output || 'Git add failed.' }
  }

  const diff = await runGit(['diff', '--cached', '--quiet'])
  if (diff.ok) {
    return { committed: false, ok: true, output: '' }
  }

  const commit = await runGit(['commit', '-m', 'Update issue list'])
  if (!commit.ok) {
    return { committed: false, ok: false, output: commit.output || 'Git commit failed.' }
  }

  return { committed: true, ok: true, output: commit.output }
}

async function syncPush(response, request) {
  const body = await readRequestJson(request)
  const gitOptions = { sshPassphrase: body.sshPassphrase }
  const commit = await commitIssueChanges()
  if (!commit.ok) {
    sendError(response, 409, commit.output)
    return
  }

  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const branch = await runGit(['branch', '--show-current'])
  const push = await runGit(
    upstream.ok ? ['push'] : ['push', '-u', 'origin', branch.ok && branch.output ? branch.output : 'main'],
    gitOptions,
  )
  if (!push.ok) {
    sendError(response, 409, push.output || 'Git push failed.')
    return
  }

  sendJson(response, 200, {
    completedAt: new Date().toISOString(),
    message: commit.committed ? 'Issue changes pushed to GitHub.' : 'No issue changes to push.',
    output: [commit.output, push.output].filter(Boolean).join('\n\n'),
  })
}

async function syncAll(response, request) {
  const body = await readRequestJson(request)
  const gitOptions = { sshPassphrase: body.sshPassphrase }
  const commit = await commitIssueChanges()
  if (!commit.ok) {
    sendError(response, 409, commit.output)
    return
  }

  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const pull = upstream.ok ? await runGit(['pull', '--rebase'], gitOptions) : { ok: true, output: '' }
  if (!pull.ok) {
    sendError(response, 409, pull.output || 'Git pull failed.')
    return
  }

  const branch = await runGit(['branch', '--show-current'])
  const push = await runGit(
    upstream.ok ? ['push'] : ['push', '-u', 'origin', branch.ok && branch.output ? branch.output : 'main'],
    gitOptions,
  )
  if (!push.ok) {
    sendError(response, 409, push.output || 'Git push failed.')
    return
  }

  sendJson(response, 200, {
    completedAt: new Date().toISOString(),
    message: 'Issue data synced with GitHub.',
    output: [commit.output, pull.output, push.output].filter(Boolean).join('\n\n'),
  })
}

async function syncConnect(response, request) {
  const body = await readRequestJson(request)
  const remoteUrl = String(body.remoteUrl ?? '').trim()

  if (!remoteUrl) {
    sendError(response, 400, 'GitHub remote URL is required.')
    return
  }

  let status = await runGit(['status', '--short'])
  const output = []

  if (!status.ok) {
    const init = await runGit(['init'])
    if (!init.ok) {
      sendError(response, 409, init.output || 'Git init failed.')
      return
    }
    output.push(init.output)

    const branch = await runGit(['branch', '-M', 'main'])
    if (!branch.ok) {
      sendError(response, 409, branch.output || 'Unable to set main branch.')
      return
    }
    output.push(branch.output)
    status = await runGit(['status', '--short'])
  }

  const existingRemote = await runGit(['remote', 'get-url', 'origin'])
  const remote = existingRemote.ok
    ? await runGit(['remote', 'set-url', 'origin', remoteUrl])
    : await runGit(['remote', 'add', 'origin', remoteUrl])

  if (!remote.ok) {
    sendError(response, 409, remote.output || 'Unable to set GitHub remote.')
    return
  }

  output.push(remote.output)

  sendJson(response, 200, {
    checkedAt: new Date().toISOString(),
    message: existingRemote.ok ? 'GitHub remote updated.' : 'GitHub remote connected.',
    output: output.filter(Boolean).join('\n\n'),
    remoteUrl,
    ready: status.ok,
  })
}

async function getProjects(response) {
  const projects = await readProjects()
  const projectsWithCounts = await Promise.all(
    projects.map(async (project) => {
      const issues = await readProjectIssues(project)
      return {
        ...project,
        archived: Boolean(project.archived),
        openCount: issues.filter((issue) => issue.status !== 'fixed').length,
      }
    }),
  )

  sendJson(response, 200, { projects: projectsWithCounts })
}

async function getCodexProjects(response) {
  const configPath = getCodexConfigPath()
  if (!configPath) {
    sendJson(response, 200, { configPath: '', projects: [] })
    return
  }

  const config = readFileSync(configPath, 'utf8')
  const projects = await readProjects()
  const trackedPaths = new Set(projects.map((project) => path.resolve(project.path).toLowerCase()))
  const projectPaths = [...config.matchAll(/^\[projects\."(.+)"\]$/gm)].map((match) =>
    match[1].replace(/\\"/g, '"'),
  )
  const uniqueProjectPaths = [...new Set(projectPaths)]
  const codexProjects = await Promise.all(
    uniqueProjectPaths.map(async (projectPath) => {
      const branch = existsSync(projectPath)
        ? await runGitIn(projectPath, ['branch', '--show-current'])
        : { ok: false, output: '' }

      return {
        branch: branch.ok && branch.output ? branch.output : 'main',
        exists: existsSync(projectPath),
        id: slugifyProjectId(path.basename(projectPath)),
        name: path.basename(projectPath),
        path: projectPath,
        tracked: trackedPaths.has(path.resolve(projectPath).toLowerCase()),
      }
    }),
  )

  sendJson(response, 200, {
    configPath,
    projects: codexProjects.sort((left, right) => left.name.localeCompare(right.name)),
  })
}

async function addProject(response, request) {
  const body = await readRequestJson(request)
  const projects = await readProjects()
  const name = String(body.name ?? '').trim()
  const projectPath = String(body.path ?? '').trim()
  const branch = String(body.branch ?? '').trim() || 'main'
  const id = slugifyProjectId(body.id || name || path.basename(projectPath))

  if (!name) {
    sendError(response, 400, 'Project name is required.')
    return
  }

  if (!projectPath) {
    sendError(response, 400, 'Project path is required.')
    return
  }

  if (!id) {
    sendError(response, 400, 'Project id could not be derived.')
    return
  }

  if (projects.some((project) => project.id === id)) {
    sendError(response, 409, 'A project with this id already exists.')
    return
  }

  if (projects.some((project) => path.resolve(project.path) === path.resolve(projectPath))) {
    sendError(response, 409, 'A project with this path already exists.')
    return
  }

  const project = {
    id,
    name,
    path: projectPath,
    branch,
    issueFile: `${id}.json`,
    archived: false,
  }

  await writeJson(getProjectsPath(), [...projects, project])
  await writeFile(projectIssuePath(project), `${JSON.stringify({ projectId: id, issues: [] }, null, 2)}\n`, {
    flag: 'wx',
  })

  sendJson(response, 201, {
    project: {
      ...project,
      openCount: 0,
    },
  })
}

async function patchProject(response, request, projectId) {
  const body = await readRequestJson(request)
  const projects = await readProjects()
  const projectIndex = projects.findIndex((project) => project.id === projectId)

  if (projectIndex === -1) {
    sendError(response, 404, 'Project not found.')
    return
  }

  const currentProject = projects[projectIndex]
  const name = body.name === undefined ? currentProject.name : String(body.name).trim()
  const projectPath = body.path === undefined ? currentProject.path : String(body.path).trim()
  const branch = body.branch === undefined ? currentProject.branch : String(body.branch).trim() || 'main'
  const archived = body.archived === undefined ? Boolean(currentProject.archived) : Boolean(body.archived)

  if (!name) {
    sendError(response, 400, 'Project name is required.')
    return
  }

  if (!projectPath) {
    sendError(response, 400, 'Project path is required.')
    return
  }

  if (
    projects.some(
      (project) =>
        project.id !== projectId && path.resolve(project.path) === path.resolve(projectPath),
    )
  ) {
    sendError(response, 409, 'A project with this path already exists.')
    return
  }

  const project = {
    ...currentProject,
    name,
    path: projectPath,
    branch,
    archived,
  }
  const nextProjects = [...projects]
  nextProjects[projectIndex] = project
  await writeJson(getProjectsPath(), nextProjects)

  sendJson(response, 200, {
    project: {
      ...project,
      openCount: (await readProjectIssues(project)).filter((issue) => issue.status !== 'fixed').length,
    },
  })
}

async function getIssues(response, searchParams) {
  const projectId = searchParams.get('project')
  if (!projectId) {
    sendError(response, 400, 'Missing project query parameter.')
    return
  }

  const projects = await readProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project) {
    sendError(response, 404, 'Project not found.')
    return
  }

  sendJson(response, 200, { issues: await readProjectIssues(project) })
}

async function getQueue(response) {
  const projects = await readProjects()
  const queue = []

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    const issues = await readProjectIssues(project)
    for (const issue of issues) {
      if (issue.status === 'fixed') {
        continue
      }

      queue.push({
        ...issue,
        projectName: project.name,
        projectPath: project.path,
      })
    }
  }

  queue.sort((left, right) => {
    const statusWeight = { 'in-progress': 0, open: 1, 'ready-for-review': 2, deferred: 3, fixed: 4 }
    const leftWeight = statusWeight[left.status] ?? 4
    const rightWeight = statusWeight[right.status] ?? 4

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight
    }

    const priorityWeight = { soon: 0, later: 1 }
    const leftPriority = priorityWeight[left.priority] ?? 1
    const rightPriority = priorityWeight[right.priority] ?? 1

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  })

  sendJson(response, 200, { issues: queue })
}

function automationPolicyAllowsIssue(issue, policy) {
  if (policy === 'all') {
    return true
  }

  if (policy === 'approved-only') {
    return issue.decision === 'approved'
  }

  if (policy === 'soon-only') {
    return issue.priority === 'soon'
  }

  if (policy === 'codex-or-approved-user') {
    return issue.source === 'Codex' || issue.decision === 'approved'
  }

  return issue.decision === 'approved' || issue.priority === 'soon'
}

async function getNextAutomationIssue(policy = 'approved-or-soon') {
  const projects = await readProjects()
  const candidates = []

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    const issues = await readProjectIssues(project)
    for (const issue of issues) {
      if (
        issue.status === 'fixed' ||
        issue.decision === 'ignored' ||
        issue.automationCompletedAt ||
        !automationPolicyAllowsIssue(issue, policy)
      ) {
        continue
      }

      candidates.push({ issue, project })
    }
  }

  candidates.sort((left, right) => {
    const priorityWeight = { soon: 0, later: 1 }
    const statusWeight = { 'in-progress': 0, open: 1, 'ready-for-review': 2, deferred: 3, fixed: 4 }
    const sourceWeight = { Codex: 0, User: 1 }
    const decisionWeight = { approved: 0, waiting: 1, ignored: 2 }
    const leftIssue = left.issue
    const rightIssue = right.issue

    return (
      (priorityWeight[leftIssue.priority] ?? 1) - (priorityWeight[rightIssue.priority] ?? 1) ||
      (statusWeight[leftIssue.status] ?? 4) - (statusWeight[rightIssue.status] ?? 4) ||
      (decisionWeight[leftIssue.decision] ?? 1) - (decisionWeight[rightIssue.decision] ?? 1) ||
      (sourceWeight[leftIssue.source] ?? 1) - (sourceWeight[rightIssue.source] ?? 1) ||
      new Date(leftIssue.createdAt).getTime() - new Date(rightIssue.createdAt).getTime()
    )
  })

  return candidates[0]
}

async function getAutomationIssueById(issueId) {
  const projects = await readProjects()

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    const issues = await readProjectIssues(project)
    const issue = issues.find((item) => item.id === issueId)
    if (issue) {
      return { issue, project }
    }
  }

  return undefined
}

function buildCodexAutomationPrompt(issue, project) {
  return [
    `You are working from Codex Companion task ${issue.id}.`,
    `Project: ${project.name}`,
    `Category: ${categoryLabels[issue.category] ?? issue.category}`,
    `Priority: ${priorityLabels[issue.priority ?? 'later'] ?? 'Action later'}`,
    `Source: ${issue.source}`,
    issue.file ? `Relevant location: ${issue.file}` : '',
    '',
    `Task title: ${issue.title}`,
    '',
    `Task details:\n${issue.detail}`,
    '',
    'Check whether this task is actionable in the current repository.',
    'If it is actionable, implement the smallest safe change that addresses it.',
    'Run focused validation where reasonable.',
    'Do not create commits.',
    'Finish by summarizing what changed, what was validated, and any remaining follow-up.',
  ].filter(Boolean).join('\n')
}

function automationStatus(response) {
  sendJson(response, 200, {
    running: automationRun?.status === 'running' || automationRun?.status === 'canceling',
    run: automationRun,
  })
}

function cancelAutomation(response) {
  if (!automationRun || automationRun.status !== 'running' || !automationChild) {
    sendError(response, 409, 'No Codex automation run is active.')
    return
  }

  automationCancelRequested = true
  automationRun = {
    ...automationRun,
    status: 'canceling',
  }
  automationChild.kill()
  sendJson(response, 202, {
    message: 'Cancel requested for Codex automation.',
    run: automationRun,
    running: true,
  })
}

async function runAutomationNext(response, request) {
  if (automationRun?.status === 'running' || automationRun?.status === 'canceling') {
    sendError(response, 409, 'Codex automation is already running.')
    return
  }

  const body = await readRequestJson(request)
  const policy = automationPolicies.has(body.policy) ? body.policy : 'approved-or-soon'
  const next = await getNextAutomationIssue(policy)
  if (!next) {
    sendJson(response, 200, {
      message: 'No queued tasks are ready for Codex automation.',
      running: false,
    })
    return
  }

  await startAutomationRun(response, next.issue, next.project, policy)
}

async function retryAutomation(response, request) {
  if (automationRun?.status === 'running' || automationRun?.status === 'canceling') {
    sendError(response, 409, 'Codex automation is already running.')
    return
  }

  const body = await readRequestJson(request)
  const issueId = String(body.issueId ?? '').trim()
  if (!issueId) {
    sendError(response, 400, 'Missing issue id for retry.')
    return
  }

  const match = await getAutomationIssueById(issueId)
  if (!match) {
    sendError(response, 404, 'Issue not found.')
    return
  }

  if (match.issue.status === 'fixed' || match.issue.decision === 'ignored') {
    sendError(response, 409, 'This task is no longer eligible for automation.')
    return
  }

  const policy = automationPolicies.has(body.policy) ? body.policy : automationRun?.policy ?? 'approved-or-soon'
  await startAutomationRun(response, match.issue, match.project, policy, true)
}

async function startAutomationRun(response, issue, project, policy, isRetry = false) {
  const cwd = resolveProjectCwd(project.path)

  if (!cwd || !existsSync(cwd)) {
    sendError(response, 409, `Project folder does not exist on this machine: ${project.path}`)
    return
  }

  const preflightStatus = await runGitIn(cwd, ['status', '--short'])
  if (!preflightStatus.ok) {
    sendError(response, 409, preflightStatus.output || `Unable to inspect Git status for ${project.path}.`)
    return
  }

  if (preflightStatus.output) {
    sendError(
      response,
      409,
      `Project has local file changes. Review or sync them before starting automation:\n${truncateOutput(preflightStatus.output, 1200)}`,
    )
    return
  }

  const startedAt = new Date().toISOString()
  const prompt = buildCodexAutomationPrompt(issue, project)
  const automationModel = String(process.env.CODEX_COMPANION_AUTOMATION_MODEL ?? 'gpt-5.2').trim()
  const allowUnsandboxed = process.env.CODEX_COMPANION_AUTOMATION_UNSANDBOXED === 'true'
  const args = [
    'exec',
    '--model',
    automationModel,
    ...(allowUnsandboxed
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write']),
    '--cd',
    cwd,
    '-',
  ]

  const startedRecord = await updateIssueRecord(issue.id, (currentIssue) => ({
    ...currentIssue,
    decision: 'approved',
    priority: currentIssue.priority ?? 'later',
    status: 'in-progress',
    activity: [
      `Codex automation ${isRetry ? 'retried' : 'started'} for ${project.name}.`,
      ...(Array.isArray(currentIssue.activity) ? currentIssue.activity : []),
    ],
  }))

  if (!startedRecord) {
    sendError(response, 404, 'Issue not found.')
    return
  }

  automationRun = {
    issueId: issue.id,
    policy,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    startedAt,
    status: 'running',
    title: issue.title,
  }

  automationCancelRequested = false
  const finishAutomationRun = async (error, stdout = '', stderr = '') => {
    const finishedAt = new Date().toISOString()
    const output = truncateOutput([stdout, stderr].filter(Boolean).join('\n'))
    const canceled = automationCancelRequested
    const ok = !error && !canceled
    const gitStatus = ok ? await runGitIn(cwd, ['status', '--short']) : undefined
    const changedFiles = ok && gitStatus?.ok ? truncateOutput(formatAutomationChangedFiles(gitStatus.output, project), 3000) : ''
    const readOnlyWithoutProjectChanges = ok && output.includes('sandbox: read-only') && !changedFiles
    const completed = ok && !readOnlyWithoutProjectChanges
    const reviewChangedFiles = completed ? changedFiles || 'No project file changes.' : ''
    const summary = canceled
      ? 'Codex automation canceled by user.'
      : completed
      ? 'Codex automation completed and is ready for review. Review the project changes and mark the task fixed when confirmed.'
      : readOnlyWithoutProjectChanges
      ? 'Codex automation finished without project changes because the spawned Codex session was read-only. Set CODEX_COMPANION_AUTOMATION_UNSANDBOXED=true to allow write-capable automation.'
      : `Codex automation failed: ${error.message}`

    await updateIssueRecord(issue.id, (currentIssue) => ({
      ...currentIssue,
      automationChangedFiles: completed ? reviewChangedFiles : currentIssue.automationChangedFiles,
      automationCompletedAt: completed ? finishedAt : currentIssue.automationCompletedAt,
      status: completed ? 'ready-for-review' : 'open',
      activity: [
        summary,
        ...(reviewChangedFiles ? [`Changed files:\n${reviewChangedFiles}`] : []),
        ...(output ? [`Codex output:\n${output}`] : []),
        ...(Array.isArray(currentIssue.activity) ? currentIssue.activity : []),
      ],
    })).catch((updateError) => {
      console.error('Unable to update automation issue:', updateError)
    })

    automationRun = {
      ...automationRun,
      changedFiles: reviewChangedFiles,
      finishedAt,
      output,
      status: canceled ? 'canceled' : completed ? 'completed' : 'failed',
    }
    automationChild = null
    automationCancelRequested = false

    setTimeout(() => {
      if (automationRun?.issueId === issue.id && automationRun.finishedAt === finishedAt) {
        automationRun = null
      }
    }, 300000)
  }

  try {
    automationChild = execFile('codex', args, {
      cwd,
      env: process.env,
      shell: true,
      timeout: Number(process.env.CODEX_COMPANION_AUTOMATION_TIMEOUT_MS ?? 900000),
    }, finishAutomationRun)
    automationChild.stdin?.end(prompt)
  } catch (error) {
    await finishAutomationRun(error)
  }

  sendJson(response, 202, {
    issue: startedRecord.issue,
    message: `${isRetry ? 'Retried' : 'Started'} Codex automation for ${issue.title}.`,
    run: automationRun,
    running: true,
  })
}

async function addIssue(response, request) {
  const body = await readRequestJson(request)
  const projects = await readProjects()
  const project = projects.find((item) => item.id === body.projectId)

  if (!project) {
    sendError(response, 404, 'Project not found.')
    return
  }

  const title = String(body.title ?? '').trim()
  if (!title) {
    sendError(response, 400, 'Issue title is required.')
    return
  }

  const issues = await readProjectIssues(project)
  const category = body.category && categoryLabels[body.category] ? body.category : 'snag'
  const priority = body.priority && priorityLabels[body.priority] ? body.priority : 'later'
  const issue = {
    id: `iss-${Date.now()}`,
    projectId: project.id,
    createdAt: new Date().toISOString(),
    title,
    file: String(body.file ?? '').trim() || undefined,
    status: body.status && statusLabels[body.status] ? body.status : 'open',
    decision: body.decision && decisionLabels[body.decision] ? body.decision : 'waiting',
    priority,
    category,
    source: body.source === 'Codex' ? 'Codex' : 'User',
    detail:
      String(body.detail ?? '').trim() ||
      'User-created snag-list item queued for future Codex work.',
    activity: Array.isArray(body.activity)
      ? body.activity
      : [
          category === 'snag'
            ? 'Snag added; Codex should check current work for a suitable opportunity to address it.'
            : 'Added from the companion app.',
        ],
  }

  await writeProjectIssues(project, [issue, ...issues])
  sendJson(response, 201, { issue })
}

async function patchIssue(response, request, issueId) {
  const body = await readRequestJson(request)
  const projects = await readProjects()

  for (const project of projects) {
    const issues = await readProjectIssues(project)
    const issueIndex = issues.findIndex((issue) => issue.id === issueId)

    if (issueIndex === -1) {
      continue
    }

    const currentIssue = issues[issueIndex]
    const nextStatus =
      body.status && statusLabels[body.status] ? body.status : currentIssue.status
    const nextDecision =
      body.decision && decisionLabels[body.decision] ? body.decision : currentIssue.decision ?? 'waiting'
    const nextPriority =
      body.priority && priorityLabels[body.priority] ? body.priority : currentIssue.priority ?? 'later'
    const activity = Array.isArray(currentIssue.activity) ? currentIssue.activity : []
    const statusChanged = nextStatus !== currentIssue.status
    const decisionChanged = nextDecision !== (currentIssue.decision ?? 'waiting')
    const priorityChanged = nextPriority !== (currentIssue.priority ?? 'later')
    const nextActivity = [
      ...(decisionChanged ? [`Codex decision changed to ${decisionLabels[nextDecision]}.`] : []),
      ...(priorityChanged ? [`Priority changed to ${priorityLabels[nextPriority]}.`] : []),
      ...(statusChanged ? [`Status changed to ${statusLabels[nextStatus]}.`] : []),
      ...activity,
    ]

    const nextTitle = body.title === undefined ? currentIssue.title : String(body.title).trim()
    if (!nextTitle) {
      sendError(response, 400, 'Issue title is required.')
      return
    }

    const nextIssue = {
      ...currentIssue,
      status: nextStatus,
      decision: nextDecision,
      priority: nextPriority,
      category:
        body.category === undefined || !categoryLabels[body.category]
          ? currentIssue.category
          : body.category,
      title: nextTitle,
      file: body.file === undefined ? currentIssue.file : String(body.file).trim() || undefined,
      detail: body.detail === undefined ? currentIssue.detail : String(body.detail).trim(),
      activity: body.activity === undefined ? nextActivity : body.activity,
    }

    const nextIssues = [...issues]
    nextIssues[issueIndex] = nextIssue
    await writeProjectIssues(project, nextIssues)
    sendJson(response, 200, { issue: nextIssue })
    return
  }

  sendError(response, 404, 'Issue not found.')
}

function aiStatus(response) {
  const config = readAppConfig()
  sendJson(response, 200, {
    connected: Boolean(config.openaiApiKey || process.env.OPENAI_API_KEY),
    model: config.openaiModel ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  })
}

async function aiConnect(response, request) {
  const body = await readRequestJson(request)
  const apiKey = String(body.apiKey ?? '').trim()
  const model = String(body.model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini').trim()

  if (!apiKey) {
    sendError(response, 400, 'OpenAI API key is required.')
    return
  }

  writeAppConfig({
    ...readAppConfig(),
    openaiApiKey: apiKey,
    openaiModel: model || 'gpt-5-mini',
  })

  sendJson(response, 200, {
    connected: true,
    model: model || 'gpt-5-mini',
  })
}

function aiDisconnect(response) {
  const nextConfig = readAppConfig()
  delete nextConfig.openaiApiKey
  delete nextConfig.openaiModel
  writeAppConfig(nextConfig)

  sendJson(response, 200, {
    connected: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  })
}

function extractResponseText(payload) {
  if (typeof payload.output_text === 'string') {
    return payload.output_text.trim()
  }

  const chunks = []
  const collectText = (value) => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (typeof value.text === 'string') {
      chunks.push(value.text)
    }

    if (Array.isArray(value)) {
      value.forEach(collectText)
      return
    }

    Object.values(value).forEach(collectText)
  }

  collectText(payload.output)
  return chunks.join('').trim()
}

function cleanAiJson(text) {
  return text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
}

async function aiSuggestTitle(response, request) {
  const config = readAppConfig()
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY

  if (!apiKey) {
    sendError(response, 401, 'Connect OpenAI before using AI suggestions.')
    return
  }

  const body = await readRequestJson(request)
  const description = String(body.description ?? '').trim()
  const category = String(body.category ?? '').trim()

  if (!description) {
    sendError(response, 400, 'Description is required to suggest a title.')
    return
  }

  const model = config.openaiModel ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini'
  const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
    body: JSON.stringify({
      instructions: [
        'You create short issue titles for a developer issue tracker.',
        'Return only one plain-text title.',
        'Do not include quotes, markdown, prefixes, or explanations.',
        'Keep the title under 80 characters.',
      ].join(' '),
      input: [
        category ? `Category: ${category}` : '',
        `Description: ${description}`,
      ].filter(Boolean).join('\n'),
      model,
      max_output_tokens: 200,
      reasoning: { effort: 'minimal' },
      store: false,
      text: {
        format: {
          type: 'text',
        },
      },
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!openAiResponse.ok) {
    const errorPayload = await openAiResponse.json().catch(() => ({}))
    sendError(
      response,
      openAiResponse.status,
      errorPayload.error?.message ?? 'OpenAI title suggestion failed.',
    )
    return
  }

  const payload = await openAiResponse.json()
  const title = extractResponseText(payload).replace(/^["']|["']$/g, '').trim()

  if (!title) {
    if (payload.status === 'incomplete' && payload.incomplete_details?.reason === 'max_output_tokens') {
      sendError(response, 502, 'OpenAI ran out of output tokens before returning a title.')
      return
    }

    sendError(response, 502, payload.error?.message ?? 'OpenAI returned no title text.')
    return
  }

  sendJson(response, 200, { title: title.split(/\r?\n/)[0].slice(0, 80) })
}

async function aiAssistIssue(response, request) {
  const config = readAppConfig()
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY

  if (!apiKey) {
    sendError(response, 401, 'Connect OpenAI before using AI assistance.')
    return
  }

  const body = await readRequestJson(request)
  const title = String(body.title ?? '').trim()
  const description = String(body.description ?? '').trim()
  const category = String(body.category ?? '').trim()
  const priority = String(body.priority ?? '').trim()
  const file = String(body.file ?? '').trim()

  if (!title && !description) {
    sendError(response, 400, 'Enter a title or description before using AI Assist.')
    return
  }

  const model = config.openaiModel ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini'
  const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
    body: JSON.stringify({
      instructions: [
        'You improve draft issue tracker entries for a developer workflow.',
        'Return only valid JSON.',
        'Use concise, practical language.',
        `Allowed categories: ${Object.keys(categoryLabels).join(', ')}.`,
        `Allowed priorities: ${Object.keys(priorityLabels).join(', ')}.`,
        'Choose priority soon only for blocking, urgent, or clearly near-term work; otherwise choose later.',
        'The detail should preserve the user intent and clarify expected behaviour.',
      ].join(' '),
      input: [
        `Current title: ${title || '(empty)'}`,
        `Current description: ${description || '(empty)'}`,
        `Current category: ${category || '(empty)'}`,
        `Current priority: ${priority || '(empty)'}`,
        `Current file: ${file || '(empty)'}`,
        'Return this exact JSON shape: {"title":"...","detail":"...","category":"snag","priority":"later"}',
      ].join('\n'),
      model,
      max_output_tokens: 500,
      reasoning: { effort: 'minimal' },
      store: false,
      text: {
        format: {
          type: 'text',
        },
      },
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!openAiResponse.ok) {
    const errorPayload = await openAiResponse.json().catch(() => ({}))
    sendError(
      response,
      openAiResponse.status,
      errorPayload.error?.message ?? 'OpenAI issue assistance failed.',
    )
    return
  }

  const payload = await openAiResponse.json()
  const outputText = extractResponseText(payload)
  if (!outputText) {
    sendError(response, 502, payload.error?.message ?? 'OpenAI returned no issue assistance text.')
    return
  }

  let suggestion
  try {
    suggestion = JSON.parse(cleanAiJson(outputText))
  } catch {
    sendError(response, 502, 'OpenAI returned issue assistance in an unexpected format.')
    return
  }

  const nextCategory = categoryLabels[suggestion.category] ? suggestion.category : category || 'snag'
  const nextPriority = priorityLabels[suggestion.priority] ? suggestion.priority : priority || 'later'

  sendJson(response, 200, {
    title: String(suggestion.title ?? title).trim().slice(0, 120),
    detail: String(suggestion.detail ?? description).trim(),
    category: nextCategory,
    priority: nextPriority,
  })
}

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    await getProjects(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/codex/projects') {
    await getCodexProjects(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/setup') {
    setupStatus(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/issues') {
    await getIssues(response, url.searchParams)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/queue') {
    await getQueue(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/automation/status') {
    automationStatus(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/automation/run-next') {
    await runAutomationNext(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/automation/retry') {
    await retryAutomation(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/automation/cancel') {
    cancelAutomation(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/status') {
    await syncStatus(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/history') {
    await syncHistory(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/ai/status') {
    aiStatus(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/ai/connect') {
    await aiConnect(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/ai/disconnect') {
    aiDisconnect(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/ai/suggest-title') {
    await aiSuggestTitle(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/ai/assist-issue') {
    await aiAssistIssue(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/issues') {
    await addIssue(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') {
    await addProject(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/setup/starter') {
    setupStarter(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/setup/existing') {
    await setupExisting(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/setup/clone') {
    await setupClone(response, request)
    return
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (request.method === 'PATCH' && projectMatch) {
    await patchProject(response, request, decodeURIComponent(projectMatch[1]))
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/pull') {
    await syncPull(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/connect') {
    await syncConnect(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/push') {
    await syncPush(response, request)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/all') {
    await syncAll(response, request)
    return
  }

  const issueMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/)
  if (request.method === 'PATCH' && issueMatch) {
    await patchIssue(response, request, decodeURIComponent(issueMatch[1]))
    return
  }

  sendError(response, 404, 'Not found.')
}

export function startIssueApiServer(options = {}) {
  loadSetupConfig()

  const serverPort = Number(options.port ?? port)
  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      console.error(error)
      sendError(response, 500, 'Unexpected server error.')
    })
  })

  server.listen(serverPort, () => {
    console.log(`Issue API listening on http://localhost:${serverPort}`)
  })

  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIssueApiServer()
}
