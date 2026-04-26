import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type IssueStatus = 'open' | 'in-progress' | 'fixed' | 'deferred'
type IssueSource = 'Codex' | 'User'
type IssueCategory = 'bug' | 'snag' | 'feature' | 'refactor' | 'docs' | 'testing' | 'question'
type StatusFilter = IssueStatus | 'all'
type CategoryFilter = IssueCategory | 'all'
type SourceFilter = IssueSource | 'all'

type Project = {
  id: string
  name: string
  path: string
  branch: string
  issueFile: string
  openCount: number
  archived: boolean
}

type Issue = {
  id: string
  projectId: string
  createdAt: string
  title: string
  file?: string
  status: IssueStatus
  category: IssueCategory
  source: IssueSource
  detail: string
  activity: string[]
}

type SyncState = {
  tone: 'ready' | 'working' | 'error' | 'success'
  message: string
  output?: string
  timestamp?: string
}

type SetupState = {
  configured: boolean
  dataDir: string
  issuesDir: string
  rootDir: string
  message?: string
  output?: string
}

declare global {
  interface Window {
    codexCompanion?: {
      chooseFolder?: (options?: { buttonLabel?: string; title?: string }) => Promise<string>
      chooseIssueFolder: () => Promise<string>
    }
  }
}

const statusLabels: Record<IssueStatus, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  fixed: 'Fixed',
  deferred: 'Deferred',
}

const categoryLabels: Record<IssueCategory, string> = {
  bug: 'Bug',
  snag: 'Snag',
  feature: 'Feature',
  refactor: 'Refactor',
  docs: 'Docs',
  testing: 'Testing',
  question: 'Question',
}

const apiBaseUrl = globalThis.location?.protocol === 'file:' ? 'http://localhost:8787' : ''

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed.' }))
    throw new Error(payload.error ?? 'Request failed.')
  }

  return response.json() as Promise<T>
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [issues, setIssues] = useState<Issue[]>([])
  const [selectedIssueId, setSelectedIssueId] = useState('')
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueFile, setNewIssueFile] = useState('')
  const [newIssueCategory, setNewIssueCategory] = useState<IssueCategory>('snag')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectBranch, setNewProjectBranch] = useState('main')
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [editProjectName, setEditProjectName] = useState('')
  const [editProjectPath, setEditProjectPath] = useState('')
  const [editProjectBranch, setEditProjectBranch] = useState('')
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editFile, setEditFile] = useState('')
  const [editCategory, setEditCategory] = useState<IssueCategory>('snag')
  const [editDetail, setEditDetail] = useState('')
  const [isSavingIssue, setIsSavingIssue] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [hideFixed, setHideFixed] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [appError, setAppError] = useState('')
  const [setupState, setSetupState] = useState<SetupState | null>(null)
  const [setupPath, setSetupPath] = useState('')
  const [setupRemoteUrl, setSetupRemoteUrl] = useState('')
  const [setupError, setSetupError] = useState('')
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [canChooseFolder, setCanChooseFolder] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>({
    tone: 'ready',
    message: 'Checking GitHub sync...',
  })

  async function loadProjectList() {
    const payload = await apiJson<{ projects: Project[] }>('/api/projects')

    setProjects(payload.projects)
    setSelectedProjectId((currentProjectId) =>
      payload.projects.some((project) => project.id === currentProjectId)
        ? currentProjectId
        : payload.projects[0]?.id || '',
    )
    setAppError('')
  }

  useEffect(() => {
    let ignore = false
    setCanChooseFolder(Boolean(window.codexCompanion?.chooseFolder || window.codexCompanion?.chooseIssueFolder))

    async function loadInitialState() {
      try {
        const setup = await apiJson<SetupState>('/api/setup')

        if (ignore) {
          return
        }

        setSetupState(setup)

        if (setup.configured) {
          await loadProjectList()
        } else {
          setProjects([])
          setIssues([])
          setSelectedProjectId('')
          setSelectedIssueId('')
        }
      } catch (error) {
        if (!ignore) {
          setSetupError(error instanceof Error ? error.message : 'Unable to load setup state.')
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }

    loadInitialState()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!selectedProjectId) {
      return
    }

    let ignore = false

    async function loadIssues() {
      setIsLoading(true)

      try {
        const payload = await apiJson<{ issues: Issue[] }>(
          `/api/issues?project=${encodeURIComponent(selectedProjectId)}`,
        )

        if (ignore) {
          return
        }

        setIssues(payload.issues)
        setSelectedIssueId(payload.issues[0]?.id || '')
        setSearchQuery('')
        setAppError('')
      } catch (error) {
        if (!ignore) {
          setAppError(error instanceof Error ? error.message : 'Unable to load issues.')
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }

    loadIssues()

    return () => {
      ignore = true
    }
  }, [selectedProjectId])

  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const visibleProjects = useMemo(
    () => projects.filter((project) => showArchivedProjects || !project.archived),
    [projects, showArchivedProjects],
  )

  useEffect(() => {
    if (!selectedProject) {
      setEditProjectName('')
      setEditProjectPath('')
      setEditProjectBranch('')
      return
    }

    setEditProjectName(selectedProject.name)
    setEditProjectPath(selectedProject.path)
    setEditProjectBranch(selectedProject.branch)
  }, [selectedProject])

  const filteredIssues = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    return issues.filter((issue) =>
      (!hideFixed || issue.status !== 'fixed') &&
      (statusFilter === 'all' || issue.status === statusFilter) &&
      (categoryFilter === 'all' || issue.category === categoryFilter) &&
      (sourceFilter === 'all' || issue.source === sourceFilter) &&
      (!query ||
        [
        issue.title,
        issue.file ?? '',
        statusLabels[issue.status],
        categoryLabels[issue.category],
        issue.source,
        issue.detail,
        ...issue.activity,
      ]
        .join(' ')
        .toLowerCase()
          .includes(query)),
    )
  }, [categoryFilter, hideFixed, issues, searchQuery, sourceFilter, statusFilter])
  const selectedIssue =
    filteredIssues.find((issue) => issue.id === selectedIssueId) ?? filteredIssues[0]

  useEffect(() => {
    if (!selectedIssue) {
      setEditTitle('')
      setEditFile('')
      setEditCategory('snag')
      setEditDetail('')
      return
    }

    setEditTitle(selectedIssue.title)
    setEditFile(selectedIssue.file ?? '')
    setEditCategory(selectedIssue.category)
    setEditDetail(selectedIssue.detail)
  }, [selectedIssue])

  function projectOpenCount(project: Project) {
    if (project.id !== selectedProjectId) {
      return project.openCount
    }

    return issues.filter((issue) => issue.status !== 'fixed').length
  }

  async function refreshSyncStatus() {
    try {
      const payload = await apiJson<{ checkedAt?: string; message: string; output?: string }>('/api/sync/status')
      setSyncState({
        tone: 'ready',
        message: payload.message,
        output: payload.output,
        timestamp: payload.checkedAt,
      })
    } catch (error) {
      setSyncState({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to check GitHub sync.',
        timestamp: new Date().toISOString(),
      })
    }
  }

  useEffect(() => {
    if (setupState?.configured) {
      refreshSyncStatus()
    }
  }, [setupState?.configured])

  async function completeSetup(action: 'starter' | 'existing' | 'clone') {
    const body =
      action === 'existing'
        ? { path: setupPath.trim() }
        : action === 'clone'
          ? { remoteUrl: setupRemoteUrl.trim() }
          : undefined

    setIsSettingUp(true)
    setSetupError('')

    try {
      const setup = await apiJson<SetupState>(`/api/setup/${action}`, {
        body: body ? JSON.stringify(body) : undefined,
        method: 'POST',
      })

      setSetupState(setup)
      await loadProjectList()
      await refreshSyncStatus()
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Unable to complete setup.')
    } finally {
      setIsSettingUp(false)
      setIsLoading(false)
    }
  }

  async function chooseFolder(options: { buttonLabel?: string; title?: string }) {
    try {
      return (
        (await window.codexCompanion?.chooseFolder?.(options)) ??
        (await window.codexCompanion?.chooseIssueFolder?.()) ??
        ''
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to choose folder.'
      setSetupError(message)
      setAppError(message)
      return ''
    }
  }

  async function chooseSetupFolder() {
    const selectedPath = await chooseFolder({
      buttonLabel: 'Use folder',
      title: 'Choose Codex Companion issue data folder',
    })
    if (selectedPath) {
      setSetupPath(selectedPath)
      setSetupError('')
    }
  }

  async function chooseNewProjectFolder() {
    const selectedPath = await chooseFolder({
      buttonLabel: 'Use project',
      title: 'Choose Codex project folder',
    })
    if (selectedPath) {
      setNewProjectPath(selectedPath)
      setAppError('')
    }
  }

  async function chooseEditProjectFolder() {
    const selectedPath = await chooseFolder({
      buttonLabel: 'Use project',
      title: 'Choose Codex project folder',
    })
    if (selectedPath) {
      setEditProjectPath(selectedPath)
      setAppError('')
    }
  }

  async function updateStatus(issueId: string, status: IssueStatus) {
    const previousIssues = issues

    setIssues((currentIssues) =>
      currentIssues.map((issue) =>
        issue.id === issueId
          ? {
              ...issue,
              status,
              activity: [`Status changed to ${statusLabels[status]}.`, ...issue.activity],
            }
          : issue,
      ),
    )

    try {
      const payload = await apiJson<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}`, {
        body: JSON.stringify({ status }),
        method: 'PATCH',
      })

      setIssues((currentIssues) =>
        currentIssues.map((issue) => (issue.id === issueId ? payload.issue : issue)),
      )
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to update issue.')
    }
  }

  async function saveIssueDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedIssue) {
      return
    }

    const title = editTitle.trim()
    if (!title) {
      setAppError('Issue title is required.')
      return
    }

    const previousIssues = issues
    const optimisticIssue = {
      ...selectedIssue,
      title,
      file: editFile.trim() || undefined,
      category: editCategory,
      detail: editDetail.trim(),
    }

    setIsSavingIssue(true)
    setIssues((currentIssues) =>
      currentIssues.map((issue) => (issue.id === selectedIssue.id ? optimisticIssue : issue)),
    )

    try {
      const payload = await apiJson<{ issue: Issue }>(`/api/issues/${encodeURIComponent(selectedIssue.id)}`, {
        body: JSON.stringify({
          title,
          file: editFile.trim(),
          category: editCategory,
          detail: editDetail.trim(),
        }),
        method: 'PATCH',
      })

      setIssues((currentIssues) =>
        currentIssues.map((issue) => (issue.id === selectedIssue.id ? payload.issue : issue)),
      )
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to save issue.')
    } finally {
      setIsSavingIssue(false)
    }
  }

  async function addIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const title = newIssueTitle.trim()
    if (!title || !selectedProject) {
      return
    }

    try {
      const payload = await apiJson<{ issue: Issue }>('/api/issues', {
        body: JSON.stringify({
          projectId: selectedProject.id,
          title,
          file: newIssueFile.trim(),
          category: newIssueCategory,
          source: 'User',
        }),
        method: 'POST',
      })

      setIssues((currentIssues) => [payload.issue, ...currentIssues])
      setSelectedIssueId(payload.issue.id)
      setNewIssueTitle('')
      setNewIssueFile('')
      setNewIssueCategory('snag')
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to add issue.')
    }
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const name = newProjectName.trim()
    const projectPath = newProjectPath.trim()
    if (!name || !projectPath) {
      setAppError('Project name and path are required.')
      return
    }

    setIsAddingProject(true)

    try {
      const payload = await apiJson<{ project: Project }>('/api/projects', {
        body: JSON.stringify({
          name,
          path: projectPath,
          branch: newProjectBranch.trim() || 'main',
        }),
        method: 'POST',
      })

      setProjects((currentProjects) => [...currentProjects, payload.project])
      setSelectedProjectId(payload.project.id)
      setIssues([])
      setSelectedIssueId('')
      setNewProjectName('')
      setNewProjectPath('')
      setNewProjectBranch('main')
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to add project.')
    } finally {
      setIsAddingProject(false)
    }
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProject) {
      return
    }

    const name = editProjectName.trim()
    const projectPath = editProjectPath.trim()

    if (!name || !projectPath) {
      setAppError('Project name and path are required.')
      return
    }

    setIsSavingProject(true)

    try {
      const payload = await apiJson<{ project: Project }>(
        `/api/projects/${encodeURIComponent(selectedProject.id)}`,
        {
          body: JSON.stringify({
            name,
            path: projectPath,
            branch: editProjectBranch.trim() || 'main',
          }),
          method: 'PATCH',
        },
      )

      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === selectedProject.id ? payload.project : project,
        ),
      )
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to save project.')
    } finally {
      setIsSavingProject(false)
    }
  }

  async function setProjectArchived(project: Project, archived: boolean) {
    setIsSavingProject(true)

    try {
      const payload = await apiJson<{ project: Project }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        {
          body: JSON.stringify({ archived }),
          method: 'PATCH',
        },
      )

      setProjects((currentProjects) => {
        const nextProjects = currentProjects.map((item) =>
          item.id === project.id ? payload.project : item,
        )
        if (archived && selectedProjectId === project.id && !showArchivedProjects) {
          const nextProject = nextProjects.find((item) => !item.archived)
          setSelectedProjectId(nextProject?.id ?? '')
          if (!nextProject) {
            setIssues([])
            setSelectedIssueId('')
          }
        }
        return nextProjects
      })
      setAppError('')
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to update project archive state.')
    } finally {
      setIsSavingProject(false)
    }
  }

  async function refreshSelectedProject() {
    if (!selectedProjectId) {
      return
    }

    const [projectsPayload, issuesPayload] = await Promise.all([
      apiJson<{ projects: Project[] }>('/api/projects'),
      apiJson<{ issues: Issue[] }>(`/api/issues?project=${encodeURIComponent(selectedProjectId)}`),
    ])

    setProjects(projectsPayload.projects)
    setIssues(issuesPayload.issues)
    setSelectedIssueId((currentIssueId) => {
      if (issuesPayload.issues.some((issue) => issue.id === currentIssueId)) {
        return currentIssueId
      }

      return issuesPayload.issues[0]?.id || ''
    })
  }

  async function runSync(action: 'pull' | 'push' | 'all') {
    const label = action === 'pull' ? 'Pull' : action === 'push' ? 'Push' : 'Sync'
    setSyncState({
      tone: 'working',
      message: `${label} in progress...`,
    })

    try {
      const payload = await apiJson<{ completedAt?: string; message: string; output?: string }>(`/api/sync/${action}`, {
        method: 'POST',
      })
      await refreshSelectedProject()
      setSyncState({
        tone: 'success',
        message: payload.message,
        output: payload.output,
        timestamp: payload.completedAt ?? new Date().toISOString(),
      })
    } catch (error) {
      setSyncState({
        tone: 'error',
        message: error instanceof Error ? error.message : `${label} failed.`,
        timestamp: new Date().toISOString(),
      })
    }
  }

  if (!setupState?.configured) {
    return (
      <main className="setup-shell">
        <section className="setup-panel" aria-label="Codex Companion setup">
          <div className="setup-heading">
            <div className="brand-mark">C</div>
            <div>
              <p className="eyebrow">Codex Companion</p>
              <h1>Connect issue data</h1>
            </div>
          </div>

          <div className="setup-summary">
            <p>Default store</p>
            <code>{setupState?.dataDir ?? 'Checking setup...'}</code>
          </div>

          {setupError ? <div className="error-banner">{setupError}</div> : null}

          <div className="setup-options">
            <div className="setup-option">
              <div>
                <h2>Starter local data</h2>
                <p>Create a fresh issue store in the default Codex Companion folder.</p>
              </div>
              <button
                disabled={isLoading || isSettingUp}
                onClick={() => completeSetup('starter')}
                type="button"
              >
                Use starter
              </button>
            </div>

            <form
              className="setup-option"
              onSubmit={(event) => {
                event.preventDefault()
                completeSetup('existing')
              }}
            >
              <div>
                <h2>Existing folder</h2>
                <p>Connect a folder that already contains issue JSON files.</p>
              </div>
              <div className={`setup-form-row ${canChooseFolder ? 'with-browse' : ''}`}>
                <input
                  aria-label="Existing issue data folder"
                  onChange={(event) => setSetupPath(event.target.value)}
                  placeholder="/mnt/c/dev/issue-management"
                  value={setupPath}
                />
                {canChooseFolder ? (
                  <button
                    disabled={isLoading || isSettingUp}
                    onClick={chooseSetupFolder}
                    type="button"
                  >
                    Browse
                  </button>
                ) : null}
                <button disabled={isLoading || isSettingUp} type="submit">
                  Connect
                </button>
              </div>
            </form>

            <form
              className="setup-option"
              onSubmit={(event) => {
                event.preventDefault()
                completeSetup('clone')
              }}
            >
              <div>
                <h2>GitHub issue repo</h2>
                <p>Clone a Git-backed issue store into the Codex Companion folder.</p>
              </div>
              <div className="setup-form-row">
                <input
                  aria-label="GitHub repository URL"
                  onChange={(event) => setSetupRemoteUrl(event.target.value)}
                  placeholder="https://github.com/user/issues.git"
                  value={setupRemoteUrl}
                />
                <button disabled={isLoading || isSettingUp} type="submit">
                  Clone
                </button>
              </div>
            </form>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="companion-shell">
      <aside className="project-sidebar" aria-label="Projects">
        <div className="brand-block">
          <div className="brand-mark">C</div>
          <div>
            <p className="eyebrow">Codex Companion</p>
            <h1>Issues</h1>
          </div>
        </div>

        <div className="sidebar-section">
          <p className="section-label">Projects</p>
          <label className="show-archived-toggle">
            <input
              checked={showArchivedProjects}
              onChange={(event) => setShowArchivedProjects(event.target.checked)}
              type="checkbox"
            />
            <span>Show archived</span>
          </label>
          <div className="project-list">
            {visibleProjects.map((project) => (
              <button
                className={`project-button ${project.id === selectedProject?.id ? 'active' : ''} ${
                  project.archived ? 'archived' : ''
                }`}
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                type="button"
              >
                <span className="project-name">{project.name}</span>
                <span className="project-path">{project.path}</span>
                <span className="project-count">
                  {project.archived ? 'Archived' : `${projectOpenCount(project)} open`}
                </span>
              </button>
            ))}
          </div>
          <form className="add-project-form" onSubmit={addProject}>
            <input
              aria-label="Project name"
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="Project name"
              value={newProjectName}
            />
            <div className={`path-input-row ${canChooseFolder ? 'with-browse' : ''}`}>
              <input
                aria-label="Project path"
                onChange={(event) => setNewProjectPath(event.target.value)}
                placeholder="/mnt/c/dev/project"
                value={newProjectPath}
              />
              {canChooseFolder ? (
                <button
                  disabled={isAddingProject}
                  onClick={chooseNewProjectFolder}
                  type="button"
                  title="Browse for project folder"
                >
                  Browse
                </button>
              ) : null}
            </div>
            <div className="add-project-row">
              <input
                aria-label="Project branch"
                onChange={(event) => setNewProjectBranch(event.target.value)}
                placeholder="main"
                value={newProjectBranch}
              />
              <button disabled={isAddingProject} type="submit" title="Add project">
                Add
              </button>
            </div>
          </form>
          {selectedProject ? (
            <form className="edit-project-form" onSubmit={saveProject}>
              <p className="section-label">Selected Project</p>
              <input
                aria-label="Selected project name"
                onChange={(event) => setEditProjectName(event.target.value)}
                value={editProjectName}
              />
              <div className={`path-input-row ${canChooseFolder ? 'with-browse' : ''}`}>
                <input
                  aria-label="Selected project path"
                  onChange={(event) => setEditProjectPath(event.target.value)}
                  value={editProjectPath}
                />
                {canChooseFolder ? (
                  <button
                    disabled={isSavingProject}
                    onClick={chooseEditProjectFolder}
                    type="button"
                    title="Browse for project folder"
                  >
                    Browse
                  </button>
                ) : null}
              </div>
              <div className="add-project-row">
                <input
                  aria-label="Selected project branch"
                  onChange={(event) => setEditProjectBranch(event.target.value)}
                  value={editProjectBranch}
                />
                <button disabled={isSavingProject} type="submit" title="Save project">
                  Save
                </button>
              </div>
              <button
                className="archive-project-button"
                disabled={isSavingProject}
                onClick={() => setProjectArchived(selectedProject, !selectedProject.archived)}
                type="button"
              >
                {selectedProject.archived ? 'Restore project' : 'Archive project'}
              </button>
            </form>
          ) : null}
        </div>

        <div className={`sync-panel ${syncState.tone}`}>
          <p className="section-label">GitHub Sync</p>
          <div className="sync-state">
            <span className="pulse"></span>
            <span>{syncState.message}</span>
          </div>
          {syncState.timestamp ? (
            <p className="sync-time">Last checked {formatTime(syncState.timestamp)}</p>
          ) : null}
          {syncState.output ? <pre className="sync-output">{syncState.output}</pre> : null}
          <div className="sync-actions" aria-label="GitHub sync actions">
            <button
              className="primary-sync"
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('all')}
              type="button"
              title="Commit issue changes, pull from GitHub, then push"
            >
              Sync
            </button>
            <button
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('pull')}
              type="button"
              title="Pull issue files from GitHub"
            >
              Pull
            </button>
            <button
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('push')}
              type="button"
              title="Commit and push issue files to GitHub"
            >
              Push
            </button>
          </div>
        </div>
      </aside>

      <section className="issue-pane" aria-label="Issues">
        <header className="pane-header">
          <div>
            <p className="eyebrow">{selectedProject?.branch ?? 'Loading'}</p>
            <h2>{selectedProject?.name ?? 'Projects'}</h2>
          </div>
          <div className="header-tools">
            <label className="search-field">
              <span>Search issues</span>
              <input
                aria-label="Search issues"
                disabled={!selectedProject}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search title, file, status..."
                type="search"
                value={searchQuery}
              />
            </label>
            <div className="codex-state">
              <span className="blue-dot"></span>
              Codex is watching this project
            </div>
          </div>
        </header>

        {appError ? <div className="error-banner">{appError}</div> : null}

        <form className="quick-add" onSubmit={addIssue}>
          <input
            aria-label="Issue name"
            disabled={!selectedProject}
            onChange={(event) => setNewIssueTitle(event.target.value)}
            placeholder="Add a snag, tweak, or future request"
            value={newIssueTitle}
          />
          <input
            aria-label="File path"
            disabled={!selectedProject}
            onChange={(event) => setNewIssueFile(event.target.value)}
            placeholder="Optional file path"
            value={newIssueFile}
          />
          <select
            aria-label="Issue category"
            disabled={!selectedProject}
            onChange={(event) => setNewIssueCategory(event.target.value as IssueCategory)}
            value={newIssueCategory}
          >
            {(Object.keys(categoryLabels) as IssueCategory[]).map((category) => (
              <option key={category} value={category}>
                {categoryLabels[category]}
              </option>
            ))}
          </select>
          <button disabled={!selectedProject} type="submit" title="Add issue">
            +
          </button>
        </form>

        <div className="issue-filters" aria-label="Issue filters">
          <label>
            <span>Status</span>
            <select
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              value={statusFilter}
            >
              <option value="all">All</option>
              {(Object.keys(statusLabels) as IssueStatus[]).map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Category</span>
            <select
              onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
              value={categoryFilter}
            >
              <option value="all">All</option>
              {(Object.keys(categoryLabels) as IssueCategory[]).map((category) => (
                <option key={category} value={category}>
                  {categoryLabels[category]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Source</span>
            <select
              onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
              value={sourceFilter}
            >
              <option value="all">All</option>
              <option value="Codex">Codex</option>
              <option value="User">User</option>
            </select>
          </label>
          <label className="hide-fixed-toggle">
            <input
              checked={hideFixed}
              onChange={(event) => setHideFixed(event.target.checked)}
              type="checkbox"
            />
            <span>Hide fixed</span>
          </label>
        </div>

        <div className="issue-list">
          {filteredIssues.map((issue) => (
            <button
              className={`issue-row ${issue.status} ${issue.id === selectedIssue?.id ? 'selected' : ''}`}
              key={issue.id}
              onClick={() => setSelectedIssueId(issue.id)}
              type="button"
            >
              <span className="status-glyph" aria-hidden="true"></span>
              <span className="issue-time">{formatDate(issue.createdAt)}</span>
              <span className="issue-title">{issue.title}</span>
              <span className={`category-pill ${issue.category}`}>
                {categoryLabels[issue.category]}
              </span>
              <span className="issue-file">{issue.file ?? 'Project note'}</span>
              <span className="issue-source">{issue.source}</span>
            </button>
          ))}
          {!isLoading && filteredIssues.length === 0 ? (
            <div className="empty-state">
              <p>{issues.length ? 'No issues match these filters.' : 'No issues in this project yet.'}</p>
              {issues.length ? (
                <button
                  onClick={() => {
                    setSearchQuery('')
                    setStatusFilter('all')
                    setCategoryFilter('all')
                    setSourceFilter('all')
                    setHideFixed(false)
                  }}
                  type="button"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="detail-panel" aria-label="Issue details">
        {selectedIssue && selectedProject ? (
          <>
            <form className="detail-form" onSubmit={saveIssueDetails}>
              <div className="detail-header">
                <p className="eyebrow">{formatDate(selectedIssue.createdAt)}</p>
                <label className="detail-field title-field">
                  <span>Issue name</span>
                  <input
                    onChange={(event) => setEditTitle(event.target.value)}
                    value={editTitle}
                  />
                </label>
                <span className={`status-pill ${selectedIssue.status}`}>{statusLabels[selectedIssue.status]}</span>
              </div>

              <label className="detail-field">
                <span>Location</span>
                <input
                  onChange={(event) => setEditFile(event.target.value)}
                  placeholder={selectedProject.path}
                  value={editFile}
                />
              </label>

              <label className="detail-field">
                <span>Category</span>
                <select
                  onChange={(event) => setEditCategory(event.target.value as IssueCategory)}
                  value={editCategory}
                >
                  {(Object.keys(categoryLabels) as IssueCategory[]).map((category) => (
                    <option key={category} value={category}>
                      {categoryLabels[category]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="detail-field">
                <span>Notes</span>
                <textarea
                  onChange={(event) => setEditDetail(event.target.value)}
                  rows={5}
                  value={editDetail}
                />
              </label>

              <button className="save-issue-button" disabled={isSavingIssue} type="submit">
                {isSavingIssue ? 'Saving...' : 'Save changes'}
              </button>
            </form>

            <div className="status-controls" aria-label="Set issue status">
              {(Object.keys(statusLabels) as IssueStatus[]).map((status) => (
                <button
                  className={selectedIssue.status === status ? 'active' : ''}
                  key={status}
                  onClick={() => updateStatus(selectedIssue.id, status)}
                  type="button"
                >
                  {statusLabels[status]}
                </button>
              ))}
            </div>

            <div className="detail-section">
              <p className="section-label">Codex Activity</p>
              <ol className="activity-list">
                {selectedIssue.activity.map((item, index) => (
                  <li key={`${selectedIssue.id}-${index}`}>{item}</li>
                ))}
              </ol>
            </div>
          </>
        ) : (
          <p>{isLoading ? 'Loading issues...' : 'No issue selected.'}</p>
        )}
      </aside>
    </main>
  )
}

export default App
