import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.ISSUE_API_PORT ?? 8787)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

  if (!status.ok) {
    sendJson(response, 200, {
      ready: false,
      message: 'Issue Management is not connected to a git repository yet.',
      output: status.output,
    })
    return
  }

  sendJson(response, 200, {
    branch: branch.ok ? branch.output : '',
    dirty: Boolean(status.output),
    ready: true,
    message: status.output ? 'Local issue changes are waiting to be pushed.' : 'Working tree is clean.',
    output: status.output,
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

async function syncPush(response) {
  const add = await runGit(['add', 'issues/'])
  if (!add.ok) {
    sendError(response, 409, add.output || 'Git add failed.')
    return
  }

  const diff = await runGit(['diff', '--cached', '--quiet'])
  if (diff.ok) {
    sendJson(response, 200, {
      message: 'No issue changes to push.',
      output: '',
    })
    return
  }

  const commit = await runGit(['commit', '-m', 'Update issue list'])
  if (!commit.ok) {
    sendError(response, 409, commit.output || 'Git commit failed.')
    return
  }

  const push = await runGit(['push'])
  if (!push.ok) {
    sendError(response, 409, push.output || 'Git push failed.')
    return
  }

  sendJson(response, 200, {
    message: 'Issue changes pushed to GitHub.',
    output: [commit.output, push.output].filter(Boolean).join('\n\n'),
  })
}

async function getProjects(response) {
  const projects = await readProjects()
  const projectsWithCounts = await Promise.all(
    projects.map(async (project) => {
      const issues = await readProjectIssues(project)
      return {
        ...project,
        openCount: issues.filter((issue) => issue.status !== 'fixed').length,
      }
    }),
  )

  sendJson(response, 200, { projects: projectsWithCounts })
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

    const nextIssue = {
      ...currentIssue,
      status: nextStatus,
      category:
        body.category === undefined || !categoryLabels[body.category]
          ? currentIssue.category
          : body.category,
      title: body.title === undefined ? currentIssue.title : String(body.title).trim(),
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

  if (request.method === 'POST' && url.pathname === '/api/sync/pull') {
    await syncPull(response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/push') {
    await syncPush(response)
    return
  }

  const issueMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/)
  if (request.method === 'PATCH' && issueMatch) {
    await patchIssue(response, request, decodeURIComponent(issueMatch[1]))
    return
  }

  sendError(response, 404, 'Not found.')
}

createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error)
    sendError(response, 500, 'Unexpected server error.')
  })
}).listen(port, () => {
  console.log(`Issue API listening on http://localhost:${port}`)
})
