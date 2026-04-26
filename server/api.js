import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const port = Number(process.env.ISSUE_API_PORT ?? 8787)
const rootDir = path.resolve(process.env.ISSUE_ROOT_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const issuesDir = path.join(rootDir, 'issues')
const projectsPath = path.join(issuesDir, 'projects.json')
const execFileAsync = promisify(execFile)

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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

async function readProjects() {
  return readJson(projectsPath)
}

function slugifyProjectId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function projectIssuePath(project) {
  return path.join(issuesDir, project.issueFile ?? `${project.id}.json`)
}

async function readProjectIssues(project) {
  try {
    const issueFile = await readJson(projectIssuePath(project))
    return Array.isArray(issueFile.issues) ? issueFile.issues : []
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

async function runGit(args) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: rootDir,
      timeout: 30000,
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

async function syncStatus(response) {
  const status = await runGit(['status', '--short'])
  const branch = await runGit(['branch', '--show-current'])
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const divergence = upstream.ok ? await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD']) : undefined

  if (!status.ok) {
    sendJson(response, 200, {
      checkedAt: new Date().toISOString(),
      ready: false,
      message: 'Issue Management is not connected to a git repository yet.',
      output: status.output,
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
    upstream: upstream.ok ? upstream.output : '',
  })
}

async function syncPull(response) {
  const result = await runGit(['pull', '--rebase'])

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

async function syncPush(response) {
  const commit = await commitIssueChanges()
  if (!commit.ok) {
    sendError(response, 409, commit.output)
    return
  }

  const push = await runGit(['push'])
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

async function syncAll(response) {
  const commit = await commitIssueChanges()
  if (!commit.ok) {
    sendError(response, 409, commit.output)
    return
  }

  const pull = await runGit(['pull', '--rebase'])
  if (!pull.ok) {
    sendError(response, 409, pull.output || 'Git pull failed.')
    return
  }

  const push = await runGit(['push'])
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

  await writeJson(projectsPath, [...projects, project])
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
  await writeJson(projectsPath, nextProjects)

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
    const activity = Array.isArray(currentIssue.activity) ? currentIssue.activity : []
    const statusChanged = nextStatus !== currentIssue.status
    const nextActivity = statusChanged
      ? [`Status changed to ${statusLabels[nextStatus]}.`, ...activity]
      : activity

    const nextTitle = body.title === undefined ? currentIssue.title : String(body.title).trim()
    if (!nextTitle) {
      sendError(response, 400, 'Issue title is required.')
      return
    }

    const nextIssue = {
      ...currentIssue,
      status: nextStatus,
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

  if (request.method === 'GET' && url.pathname === '/api/issues') {
    await getIssues(response, url.searchParams)
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/status') {
    await syncStatus(response)
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

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (request.method === 'PATCH' && projectMatch) {
    await patchProject(response, request, decodeURIComponent(projectMatch[1]))
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/pull') {
    await syncPull(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/push') {
    await syncPush(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/all') {
    await syncAll(response)
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
