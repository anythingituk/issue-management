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

const statusLabels = {
  open: 'Open',
  'in-progress': 'In progress',
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function getRootDir() {
  return configuredRootDir ?? defaultRootDir
}

function getDataDir() {
  return path.resolve(process.env.CODEX_COMPANION_DATA_DIR ?? getRootDir())
}

function getConfigPath() {
  return path.join(getDataDir(), 'config.json')
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
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    if (config.issueRootDir) {
      configuredRootDir = path.resolve(String(config.issueRootDir))
      process.env.ISSUE_ROOT_DIR = configuredRootDir
    }
  } catch (error) {
    console.warn(`Unable to read Codex Companion config at ${configPath}:`, error)
  }
}

function saveSetupConfig(rootDir) {
  const nextRootDir = path.resolve(rootDir)
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ issueRootDir: nextRootDir }, null, 2)}\n`,
  )
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

async function readProjectIssues(project) {
  try {
    const issueFile = await readJson(projectIssuePath(project))
    return Array.isArray(issueFile.issues)
      ? issueFile.issues.map((issue) => ({
          ...issue,
          decision: issue.decision && decisionLabels[issue.decision] ? issue.decision : 'waiting',
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
    const statusWeight = { 'in-progress': 0, open: 1, deferred: 2, fixed: 3 }
    const leftWeight = statusWeight[left.status] ?? 4
    const rightWeight = statusWeight[right.status] ?? 4

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  })

  sendJson(response, 200, { issues: queue })
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
  const issue = {
    id: `iss-${Date.now()}`,
    projectId: project.id,
    createdAt: new Date().toISOString(),
    title,
    file: String(body.file ?? '').trim() || undefined,
    status: body.status && statusLabels[body.status] ? body.status : 'open',
    decision: body.decision && decisionLabels[body.decision] ? body.decision : 'waiting',
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
    const activity = Array.isArray(currentIssue.activity) ? currentIssue.activity : []
    const statusChanged = nextStatus !== currentIssue.status
    const decisionChanged = nextDecision !== (currentIssue.decision ?? 'waiting')
    const nextActivity = [
      ...(decisionChanged ? [`Codex decision changed to ${decisionLabels[nextDecision]}.`] : []),
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

  if (request.method === 'GET' && url.pathname === '/api/sync/status') {
    await syncStatus(response)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/history') {
    await syncHistory(response)
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
