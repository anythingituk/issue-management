#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const issuesDir = path.join(rootDir, 'issues')
const projectsPath = path.join(issuesDir, 'projects.json')

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

const validSources = new Set(['Codex', 'User'])

function usage() {
  console.log(`Usage:
  issue-manager add --project <id-or-path> --title <title> [--file <path>] [--category bug|snag|feature|refactor|docs|testing|question] [--source Codex|User] [--detail <text>] [--status open|in-progress|fixed|deferred]
  issue-manager status --id <issue-id> --status open|in-progress|fixed|deferred
  issue-manager activity --id <issue-id> --message <text>
  issue-manager list [--project <id-or-path>]

Examples:
  issue-manager add --project /mnt/c/dev/IssueManagement --title "Button overflows on mobile" --file src/App.css --category bug --source Codex
  issue-manager status --id iss-001 --status fixed
  issue-manager activity --id iss-001 --message "Codex started inspecting src/App.css."`)
}

function parseArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const key = arg.slice(2)
    const value = argv[index + 1]

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    options[key] = value
    index += 1
  }

  return options
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

function normalizePath(value) {
  return path.resolve(value).replaceAll('\\', '/')
}

function projectIssuePath(project) {
  return path.join(issuesDir, project.issueFile ?? `${project.id}.json`)
}

function findProject(projects, selector) {
  if (!selector) {
    throw new Error('Missing --project.')
  }

  const projectById = projects.find((project) => project.id === selector)
  if (projectById) {
    return projectById
  }

  if (!path.isAbsolute(selector)) {
    return undefined
  }

  const normalizedSelector = normalizePath(selector)
  return projects.find((project) => {
    const normalizedProjectPath = normalizePath(project.path)
    return (
      normalizedProjectPath === normalizedSelector ||
      normalizedSelector.startsWith(`${normalizedProjectPath}/`)
    )
  })
}

async function readProjectIssues(project) {
  const issueFile = await readJson(projectIssuePath(project))
  return Array.isArray(issueFile.issues) ? issueFile.issues : []
}

async function writeProjectIssues(project, issues) {
  await writeJson(projectIssuePath(project), {
    projectId: project.id,
    issues,
  })
}

async function findIssue(projects, issueId) {
  if (!issueId) {
    throw new Error('Missing --id.')
  }

  for (const project of projects) {
    const issues = await readProjectIssues(project)
    const issueIndex = issues.findIndex((issue) => issue.id === issueId)

    if (issueIndex !== -1) {
      return { issue: issues[issueIndex], issueIndex, issues, project }
    }
  }

  throw new Error(`Issue not found: ${issueId}`)
}

function requireStatus(status) {
  if (!statusLabels[status]) {
    throw new Error(`Invalid status: ${status}`)
  }

  return status
}

function requireCategory(category) {
  if (!categoryLabels[category]) {
    throw new Error(`Invalid category: ${category}`)
  }

  return category
}

async function addIssue(options) {
  const projects = await readProjects()
  const project = findProject(projects, options.project)

  if (!project) {
    throw new Error(`Project not found: ${options.project}`)
  }

  const title = String(options.title ?? '').trim()
  if (!title) {
    throw new Error('Missing --title.')
  }

  const source = options.source ?? 'Codex'
  if (!validSources.has(source)) {
    throw new Error(`Invalid source: ${source}`)
  }

  const issues = await readProjectIssues(project)
  const category = options.category ? requireCategory(options.category) : 'snag'
  const issue = {
    id: `iss-${Date.now()}`,
    projectId: project.id,
    createdAt: new Date().toISOString(),
    title,
    file: String(options.file ?? '').trim() || undefined,
    status: options.status ? requireStatus(options.status) : 'open',
    category,
    source,
    detail:
      String(options.detail ?? '').trim() ||
      `${source}-created issue queued for future work.`,
    activity: [
      category === 'snag'
        ? 'Snag added; Codex should check current work for a suitable opportunity to address it.'
        : `Added by ${source} through issue-manager.`,
    ],
  }

  await writeProjectIssues(project, [issue, ...issues])
  console.log(JSON.stringify({ issue }, null, 2))
}

async function updateStatus(options) {
  const status = requireStatus(options.status)
  const projects = await readProjects()
  const { issue, issueIndex, issues, project } = await findIssue(projects, options.id)
  const nextIssue = {
    ...issue,
    status,
    activity: [`Status changed to ${statusLabels[status]}.`, ...(issue.activity ?? [])],
  }

  const nextIssues = [...issues]
  nextIssues[issueIndex] = nextIssue
  await writeProjectIssues(project, nextIssues)
  console.log(JSON.stringify({ issue: nextIssue }, null, 2))
}

async function addActivity(options) {
  const message = String(options.message ?? '').trim()
  if (!message) {
    throw new Error('Missing --message.')
  }

  const projects = await readProjects()
  const { issue, issueIndex, issues, project } = await findIssue(projects, options.id)
  const nextIssue = {
    ...issue,
    activity: [message, ...(issue.activity ?? [])],
  }

  const nextIssues = [...issues]
  nextIssues[issueIndex] = nextIssue
  await writeProjectIssues(project, nextIssues)
  console.log(JSON.stringify({ issue: nextIssue }, null, 2))
}

async function listIssues(options) {
  const projects = await readProjects()
  const selectedProject = options.project ? findProject(projects, options.project) : undefined
  const selectedProjects = selectedProject ? [selectedProject] : projects

  if (options.project && !selectedProject) {
    throw new Error(`Project not found: ${options.project}`)
  }

  const rows = []

  for (const project of selectedProjects) {
    const issues = await readProjectIssues(project)
    for (const issue of issues) {
      rows.push({
        id: issue.id,
        project: project.id,
        status: issue.status,
        category: issue.category ?? 'snag',
        source: issue.source,
        title: issue.title,
        file: issue.file ?? '',
      })
    }
  }

  console.table(rows)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help') {
    usage()
    return
  }

  const options = parseArgs(args)

  if (command === 'add') {
    await addIssue(options)
    return
  }

  if (command === 'status') {
    await updateStatus(options)
    return
  }

  if (command === 'activity') {
    await addActivity(options)
    return
  }

  if (command === 'list') {
    await listIssues(options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`issue-manager: ${error.message}`)
  process.exitCode = 1
})
