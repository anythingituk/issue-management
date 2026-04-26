import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type IssueStatus = 'open' | 'in-progress' | 'fixed' | 'deferred'
type IssueSource = 'Codex' | 'User'
type IssueCategory = 'bug' | 'snag' | 'feature' | 'refactor' | 'docs' | 'testing' | 'question'

type Project = {
  id: string
  name: string
  path: string
  branch: string
  issueFile: string
  openCount: number
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

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [appError, setAppError] = useState('')
  const [syncState, setSyncState] = useState<SyncState>({
    tone: 'ready',
    message: 'Checking GitHub sync...',
  })

  useEffect(() => {
    let ignore = false

    async function loadProjects() {
      try {
        const payload = await apiJson<{ projects: Project[] }>('/api/projects')

        if (ignore) {
          return
        }

        setProjects(payload.projects)
        setSelectedProjectId((currentProjectId) => currentProjectId || payload.projects[0]?.id || '')
        setAppError('')
      } catch (error) {
        if (!ignore) {
          setAppError(error instanceof Error ? error.message : 'Unable to load projects.')
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }

    loadProjects()

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
  const filteredIssues = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    if (!query) {
      return issues
    }

    return issues.filter((issue) =>
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
        .includes(query),
    )
  }, [issues, searchQuery])
  const selectedIssue =
    filteredIssues.find((issue) => issue.id === selectedIssueId) ?? filteredIssues[0]

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
    refreshSyncStatus()
  }, [])

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
          <div className="project-list">
            {projects.map((project) => (
              <button
                className={`project-button ${project.id === selectedProject?.id ? 'active' : ''}`}
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                type="button"
              >
                <span className="project-name">{project.name}</span>
                <span className="project-path">{project.path}</span>
                <span className="project-count">{projectOpenCount(project)} open</span>
              </button>
            ))}
          </div>
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
              <p>{searchQuery ? 'No issues match this search.' : 'No issues in this project yet.'}</p>
              {searchQuery ? (
                <button onClick={() => setSearchQuery('')} type="button">
                  Clear search
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="detail-panel" aria-label="Issue details">
        {selectedIssue && selectedProject ? (
          <>
            <div className="detail-header">
              <p className="eyebrow">{formatDate(selectedIssue.createdAt)}</p>
              <h2>{selectedIssue.title}</h2>
              <span className={`status-pill ${selectedIssue.status}`}>{statusLabels[selectedIssue.status]}</span>
            </div>

            <div className="detail-section">
              <p className="section-label">Location</p>
              <code>{selectedIssue.file ?? selectedProject.path}</code>
            </div>

            <div className="detail-section">
              <p className="section-label">Category</p>
              <span className={`category-pill detail ${selectedIssue.category}`}>
                {categoryLabels[selectedIssue.category]}
              </span>
            </div>

            <div className="detail-section">
              <p className="section-label">Notes</p>
              <p>{selectedIssue.detail}</p>
            </div>

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
