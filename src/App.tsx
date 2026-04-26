import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type IssueStatus = 'open' | 'in-progress' | 'fixed' | 'deferred'
type IssueSource = 'Codex' | 'User'
type IssueCategory = 'bug' | 'snag' | 'feature' | 'refactor' | 'docs' | 'testing' | 'question'
type IssueDecision = 'approved' | 'waiting' | 'ignored'
type StatusFilter = IssueStatus | 'all'
type CategoryFilter = IssueCategory | 'all'
type SourceFilter = IssueSource | 'all'
type SyncAction = 'pull' | 'push' | 'all'
type Toast = {
  id: string
  message: string
  title: string
  tone: 'info' | 'success' | 'warning'
}

type Project = {
  id: string
  name: string
  path: string
  branch: string
  issueFile: string
  openCount: number
  archived: boolean
}

type CodexProject = {
  id: string
  name: string
  path: string
  branch: string
  exists: boolean
  tracked: boolean
}

type Issue = {
  id: string
  projectId: string
  createdAt: string
  title: string
  file?: string
  status: IssueStatus
  decision: IssueDecision
  category: IssueCategory
  source: IssueSource
  detail: string
  activity: string[]
}

type QueueIssue = Issue & {
  projectName: string
  projectPath: string
}

type SyncState = {
  tone: 'ready' | 'working' | 'error' | 'success'
  ready?: boolean
  message: string
  output?: string
  remoteUrl?: string
  timestamp?: string
}

type SyncEvent = {
  id: string
  createdAt?: string
  detail?: string
  shortHash?: string
  status: string
  title: string
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
      apiBaseUrl?: string
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

const decisionLabels: Record<IssueDecision, string> = {
  approved: 'Approved for Codex',
  waiting: 'Waiting for confirmation',
  ignored: 'Ignore for now',
}

const decisionGlyphs: Record<IssueDecision, string> = {
  approved: '✓',
  waiting: '○',
  ignored: '×',
}

const apiBaseUrl =
  window.codexCompanion?.apiBaseUrl ??
  (globalThis.location?.protocol === 'file:' ? 'http://localhost:8787' : '')

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
  const [queueIssues, setQueueIssues] = useState<QueueIssue[]>([])
  const [selectedIssueId, setSelectedIssueId] = useState('')
  const [paneMode, setPaneMode] = useState<'workbench' | 'project' | 'codex' | 'user'>('workbench')
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueFile, setNewIssueFile] = useState('')
  const [newIssueCategory, setNewIssueCategory] = useState<IssueCategory>('snag')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectBranch, setNewProjectBranch] = useState('main')
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [showAddProjectForm, setShowAddProjectForm] = useState(false)
  const [editProjectName, setEditProjectName] = useState('')
  const [editProjectPath, setEditProjectPath] = useState('')
  const [editProjectBranch, setEditProjectBranch] = useState('')
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [openProjectSettingsId, setOpenProjectSettingsId] = useState('')
  const [codexProjects, setCodexProjects] = useState<CodexProject[]>([])
  const [isLoadingCodexProjects, setIsLoadingCodexProjects] = useState(false)
  const [addingCodexProjectPath, setAddingCodexProjectPath] = useState('')
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
  const [issueDataPath, setIssueDataPath] = useState('')
  const [isSwitchingIssueData, setIsSwitchingIssueData] = useState(false)
  const [gitRemoteUrl, setGitRemoteUrl] = useState('')
  const [isConnectingGit, setIsConnectingGit] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>({
    tone: 'ready',
    message: 'Checking GitHub sync...',
  })
  const [syncHistory, setSyncHistory] = useState<SyncEvent[]>([])
  const [sshPassphrase, setSshPassphrase] = useState('')
  const [pendingSshAction, setPendingSshAction] = useState<SyncAction | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  function showToast(toastContent: Omit<Toast, 'id'>) {
    setToast({
      ...toastContent,
      id: `toast-${Date.now()}`,
    })
  }

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

  async function loadQueue() {
    const payload = await apiJson<{ issues: QueueIssue[] }>('/api/queue')
    setQueueIssues(payload.issues)
  }

  async function loadCodexProjects() {
    setIsLoadingCodexProjects(true)
    try {
      const payload = await apiJson<{ projects: CodexProject[] }>('/api/codex/projects')
      setCodexProjects(payload.projects)
    } finally {
      setIsLoadingCodexProjects(false)
    }
  }

  async function loadSyncHistory() {
    const payload = await apiJson<{ events: SyncEvent[]; remoteUrl?: string }>('/api/sync/history')
    setSyncHistory(payload.events)
    if (payload.remoteUrl) {
      setGitRemoteUrl(payload.remoteUrl)
    }
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
        setIssueDataPath(setup.rootDir)

        if (setup.configured) {
          await loadProjectList()
          await loadQueue()
          await loadCodexProjects()
        } else {
          setProjects([])
          setIssues([])
          setQueueIssues([])
          setCodexProjects([])
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
        setSelectedIssueId((currentIssueId) =>
          payload.issues.some((issue) => issue.id === currentIssueId)
            ? currentIssueId
            : payload.issues[0]?.id || '',
        )
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
  const selectedQueueIssue = queueIssues.find((issue) => issue.id === selectedIssueId)
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
          decisionLabels[issue.decision ?? 'waiting'],
          issue.source,
          issue.detail,
          ...issue.activity,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)),
    )
  }, [categoryFilter, hideFixed, issues, searchQuery, sourceFilter, statusFilter])

  const filteredQueueIssues = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const source = paneMode === 'user' ? 'User' : 'Codex'

    return queueIssues.filter((issue) =>
      issue.source === source &&
      (statusFilter === 'all' || issue.status === statusFilter) &&
      (categoryFilter === 'all' || issue.category === categoryFilter) &&
      (!query ||
        [
          issue.title,
          issue.file ?? '',
          issue.projectName,
          issue.projectPath,
          statusLabels[issue.status],
          categoryLabels[issue.category],
          decisionLabels[issue.decision ?? 'waiting'],
          issue.detail,
          ...issue.activity,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)),
    )
  }, [categoryFilter, paneMode, queueIssues, searchQuery, statusFilter])

  const queueCounts = useMemo(
    () => ({
      codex: queueIssues.filter((issue) => issue.source === 'Codex').length,
      codexInProgress: queueIssues.filter(
        (issue) => issue.source === 'Codex' && issue.status === 'in-progress',
      ).length,
      user: queueIssues.filter((issue) => issue.source === 'User').length,
      userSnags: queueIssues.filter(
        (issue) => issue.source === 'User' && issue.category === 'snag',
      ).length,
    }),
    [queueIssues],
  )
  const userQueueIssues = useMemo(
    () => queueIssues.filter((issue) => issue.source === 'User').slice(0, 8),
    [queueIssues],
  )
  const codexQueueIssues = useMemo(
    () => queueIssues.filter((issue) => issue.source === 'Codex').slice(0, 8),
    [queueIssues],
  )

  const selectedIssue =
    filteredIssues.find((issue) => issue.id === selectedIssueId) ??
    selectedQueueIssue ??
    filteredIssues[0]
  const detailProject =
    projects.find((project) => project.id === selectedIssue?.projectId) ?? selectedProject
  const selectedIssueQueueContext =
    selectedIssue && queueIssues.find((issue) => issue.id === selectedIssue.id)

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
      const payload = await apiJson<{
        checkedAt?: string
        message: string
        output?: string
        ready?: boolean
        remoteUrl?: string
      }>('/api/sync/status')
      if (payload.remoteUrl) {
        setGitRemoteUrl(payload.remoteUrl)
      }
      setSyncState({
        tone: 'ready',
        ready: payload.ready,
        message: payload.message,
        output: payload.output,
        remoteUrl: payload.remoteUrl,
        timestamp: payload.checkedAt,
      })
      await loadSyncHistory()
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

  useEffect(() => {
    if (!toast) {
      return
    }

    const timeout = window.setTimeout(() => setToast(null), 5200)
    return () => window.clearTimeout(timeout)
  }, [toast])

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
      setIssueDataPath(setup.rootDir)
      await loadProjectList()
      await loadQueue()
      await loadCodexProjects()
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

  async function chooseIssueDataFolder() {
    const selectedPath = await chooseFolder({
      buttonLabel: 'Use folder',
      title: 'Choose Codex Companion issue data folder',
    })
    if (selectedPath) {
      setIssueDataPath(selectedPath)
      setAppError('')
    }
  }

  async function switchIssueData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const nextPath = issueDataPath.trim()
    if (!nextPath) {
      setAppError('Issue data folder is required.')
      return
    }

    setIsSwitchingIssueData(true)

    try {
      const setup = await apiJson<SetupState>('/api/setup/existing', {
        body: JSON.stringify({ path: nextPath }),
        method: 'POST',
      })

      setSetupState(setup)
      setIssueDataPath(setup.rootDir)
      setIssues([])
      setSelectedIssueId('')
      await loadProjectList()
      await loadQueue()
      await loadCodexProjects()
      await refreshSyncStatus()
      setAppError('')
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to switch issue data.')
    } finally {
      setIsSwitchingIssueData(false)
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

  async function openQueueIssue(issue: QueueIssue) {
    setSelectedProjectId(issue.projectId)
    setSelectedIssueId(issue.id)
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
      await loadQueue()
      await loadCodexProjects()
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to update issue.')
    }
  }

  async function updateDecision(issueId: string, decision: IssueDecision) {
    const previousIssues = issues
    const previousQueueIssues = queueIssues

    setIssues((currentIssues) =>
      currentIssues.map((issue) =>
        issue.id === issueId
          ? {
              ...issue,
              decision,
              activity: [`Codex decision changed to ${decisionLabels[decision]}.`, ...issue.activity],
            }
          : issue,
      ),
    )
    setQueueIssues((currentIssues) =>
      currentIssues.map((issue) =>
        issue.id === issueId
          ? {
              ...issue,
              decision,
              activity: [`Codex decision changed to ${decisionLabels[decision]}.`, ...issue.activity],
            }
          : issue,
      ),
    )

    try {
      const payload = await apiJson<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}`, {
        body: JSON.stringify({ decision }),
        method: 'PATCH',
      })

      setIssues((currentIssues) =>
        currentIssues.map((issue) => (issue.id === issueId ? payload.issue : issue)),
      )
      setQueueIssues((currentIssues) =>
        currentIssues.map((issue) =>
          issue.id === issueId ? { ...issue, ...payload.issue } : issue,
        ),
      )
      setAppError('')
      await loadQueue()
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setQueueIssues(previousQueueIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to update Codex decision.')
    }
  }

  async function askCodexToWorkNow(issue: Issue) {
    const previousIssues = issues
    const previousQueueIssues = queueIssues
    const nextActivity = [
      'User asked Codex to work on this now.',
      ...issue.activity,
    ]
    const optimisticIssue = {
      ...issue,
      decision: 'approved' as IssueDecision,
      status: 'in-progress' as IssueStatus,
      activity: nextActivity,
    }

    setIssues((currentIssues) =>
      currentIssues.map((item) => (item.id === issue.id ? optimisticIssue : item)),
    )
    setQueueIssues((currentIssues) =>
      currentIssues.map((item) =>
        item.id === issue.id ? { ...item, ...optimisticIssue } : item,
      ),
    )

    try {
      const payload = await apiJson<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issue.id)}`, {
        body: JSON.stringify({
          activity: nextActivity,
          decision: 'approved',
          status: 'in-progress',
        }),
        method: 'PATCH',
      })

      setIssues((currentIssues) =>
        currentIssues.map((item) => (item.id === issue.id ? payload.issue : item)),
      )
      setQueueIssues((currentIssues) =>
        currentIssues.map((item) =>
          item.id === issue.id ? { ...item, ...payload.issue } : item,
        ),
      )
      setPaneMode('codex')
      setAppError('')
      showToast({
        message: 'Marked approved and in progress. The Codex issue check can now pick this up as actionable.',
        title: 'Codex work request queued',
        tone: 'success',
      })
      await loadQueue()
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setQueueIssues(previousQueueIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to ask Codex to work now.')
      showToast({
        message: error instanceof Error ? error.message : 'Unable to ask Codex to work now.',
        title: 'Codex request failed',
        tone: 'warning',
      })
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
      await loadQueue()
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
      await loadQueue()
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
      setShowAddProjectForm(false)
      setAppError('')
      await loadQueue()
      await loadCodexProjects()
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
      await loadQueue()
      await loadCodexProjects()
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to save project.')
    } finally {
      setIsSavingProject(false)
    }
  }

  async function addCodexProject(project: CodexProject) {
    setAddingCodexProjectPath(project.path)
    try {
      const payload = await apiJson<{ project: Project }>('/api/projects', {
        body: JSON.stringify({
          branch: project.branch || 'main',
          name: project.name,
          path: project.path,
        }),
        method: 'POST',
      })

      setProjects((currentProjects) => [...currentProjects, payload.project])
      setSelectedProjectId(payload.project.id)
      setPaneMode('project')
      setAppError('')
      await loadCodexProjects()
      await loadQueue()
      await refreshSyncStatus()
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Unable to add Codex project.')
    } finally {
      setAddingCodexProjectPath('')
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
      await loadQueue()
      await loadCodexProjects()
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
    await loadQueue()
    setSelectedIssueId((currentIssueId) => {
      if (issuesPayload.issues.some((issue) => issue.id === currentIssueId)) {
        return currentIssueId
      }

      return issuesPayload.issues[0]?.id || ''
    })
  }

  async function refreshWorkbench() {
    setIsRefreshing(true)

    try {
      await Promise.all([
        selectedProjectId ? refreshSelectedProject() : loadProjectList(),
        loadCodexProjects(),
        refreshSyncStatus(),
      ])
      setAppError('')
      showToast({
        message: 'Projects, queues, issue data, and GitHub status have been reloaded.',
        title: 'Codex Companion refreshed',
        tone: 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh Codex Companion.'
      setAppError(message)
      showToast({
        message,
        title: 'Refresh failed',
        tone: 'warning',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  function needsSshPassphrase(message: string) {
    return /ssh-askpass|permission denied \(publickey\)|could not read from remote repository/i.test(message)
  }

  async function runSync(action: SyncAction) {
    const label = action === 'pull' ? 'Pull' : action === 'push' ? 'Push' : 'Sync'
    const passphrase = sshPassphrase.trim()
    setSyncState({
      tone: 'working',
      message: `${label} in progress...`,
    })

    try {
      const payload = await apiJson<{ completedAt?: string; message: string; output?: string }>(`/api/sync/${action}`, {
        body: JSON.stringify(passphrase ? { sshPassphrase: passphrase } : {}),
        method: 'POST',
      })
      await refreshSelectedProject()
      setPendingSshAction(null)
      setSshPassphrase('')
      setSyncState({
        tone: 'success',
        message: payload.message,
        output: payload.output,
        timestamp: payload.completedAt ?? new Date().toISOString(),
      })
      await loadSyncHistory()
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} failed.`
      const needsPassphrase = needsSshPassphrase(message)
      setPendingSshAction(needsPassphrase ? action : null)
      setSyncState({
        tone: 'error',
        message: needsPassphrase
          ? 'SSH key passphrase required. Enter it below to retry this sync.'
          : message,
        output: needsPassphrase ? message : undefined,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async function connectGitRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const remoteUrl = gitRemoteUrl.trim()
    if (!remoteUrl) {
      setSyncState({
        tone: 'error',
        message: 'GitHub remote URL is required.',
        timestamp: new Date().toISOString(),
      })
      return
    }

    setIsConnectingGit(true)
    setSyncState({
      tone: 'working',
      message: 'Connecting GitHub remote...',
    })

    try {
      const payload = await apiJson<{ checkedAt?: string; message: string; output?: string; remoteUrl?: string }>(
        '/api/sync/connect',
        {
          body: JSON.stringify({ remoteUrl }),
          method: 'POST',
        },
      )
      setGitRemoteUrl(payload.remoteUrl ?? remoteUrl)
      await refreshSyncStatus()
      setSyncState({
        tone: 'success',
        message: payload.message,
        output: payload.output,
        remoteUrl: payload.remoteUrl ?? remoteUrl,
        timestamp: payload.checkedAt ?? new Date().toISOString(),
      })
      await loadSyncHistory()
    } catch (error) {
      setSyncState({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to connect GitHub remote.',
        timestamp: new Date().toISOString(),
      })
    } finally {
      setIsConnectingGit(false)
    }
  }

  function renderDecisionControls(issue: Issue) {
    const currentDecision = issue.decision ?? 'waiting'

    return (
      <span className="decision-controls" aria-label="Codex task decision">
        {(Object.keys(decisionLabels) as IssueDecision[]).map((decision) => (
          <button
            aria-label={decisionLabels[decision]}
            className={`decision-button ${decision} ${currentDecision === decision ? 'active' : ''}`}
            key={decision}
            onClick={(event) => {
              event.stopPropagation()
              updateDecision(issue.id, decision)
            }}
            title={decisionLabels[decision]}
            type="button"
          >
            {decisionGlyphs[decision]}
          </button>
        ))}
      </span>
    )
  }

  if (!setupState?.configured) {
    return (
      <main className="setup-shell">
        <section className="setup-panel" aria-label="Codex Companion setup">
          <div className="setup-heading">
            <img className="brand-mark" src="codex-companion-icon.png" alt="" aria-hidden="true" />
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
          <img className="brand-mark" src="codex-companion-icon.png" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow brand-title">Codex Companion</p>
          </div>
        </div>

        <div className="sidebar-section projects-panel">
          <div className="sidebar-section-header">
            <p className="section-label projects-label">Projects</p>
            <button
              aria-expanded={showProjectSettings}
              aria-label="Project settings"
              className="project-settings-toggle"
              onClick={() => setShowProjectSettings((isOpen) => !isOpen)}
              title="Project settings"
              type="button"
            >
              ⚙
            </button>
          </div>
          <div className="project-list">
            {visibleProjects.map((project) => (
              <div
                className={`project-card ${project.id === selectedProject?.id ? 'active' : ''} ${
                  project.archived ? 'archived' : ''
                } ${openProjectSettingsId === project.id ? 'settings-open' : ''}`}
                key={project.id}
              >
                <button
                  className="project-button"
                  onClick={() => setSelectedProjectId(project.id)}
                  type="button"
                >
                  <span className="project-name">{project.name}</span>
                  <span className="project-path">{project.path}</span>
                  <span className="project-count">
                    {project.archived ? 'Archived' : `${projectOpenCount(project)} open`}
                  </span>
                </button>
                <button
                  aria-expanded={openProjectSettingsId === project.id}
                  aria-label={`Settings for ${project.name}`}
                  className="project-card-settings"
                  onClick={() => {
                    setSelectedProjectId(project.id)
                    setOpenProjectSettingsId((currentId) =>
                      currentId === project.id ? '' : project.id,
                    )
                  }}
                  title="Project settings"
                  type="button"
                >
                  ⚙
                </button>
              </div>
            ))}
          </div>
          <div className="project-sidebar-actions">
            <button
              aria-expanded={showAddProjectForm}
              onClick={() => setShowAddProjectForm((isOpen) => !isOpen)}
              type="button"
            >
              {showAddProjectForm ? 'Cancel' : 'Add project'}
            </button>
            <label className="show-archived-toggle">
              <input
                checked={showArchivedProjects}
                onChange={(event) => setShowArchivedProjects(event.target.checked)}
                type="checkbox"
              />
              <span>Archived</span>
            </label>
          </div>
          {showAddProjectForm ? (
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
          ) : null}

          {selectedProject && openProjectSettingsId === selectedProject.id ? (
            <div className="project-local-settings">
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

              <form className="data-store-panel" onSubmit={switchIssueData}>
                <p className="section-label">Issue Data</p>
                <code>{setupState.rootDir}</code>
                <div className={`path-input-row ${canChooseFolder ? 'with-browse' : ''}`}>
                  <input
                    aria-label="Issue data folder"
                    onChange={(event) => setIssueDataPath(event.target.value)}
                    value={issueDataPath}
                  />
                  {canChooseFolder ? (
                    <button
                      disabled={isSwitchingIssueData}
                      onClick={chooseIssueDataFolder}
                      type="button"
                      title="Browse for issue data folder"
                    >
                      Browse
                    </button>
                  ) : null}
                </div>
                <button disabled={isSwitchingIssueData} type="submit">
                  {isSwitchingIssueData ? 'Switching...' : 'Use folder'}
                </button>
              </form>
            </div>
          ) : null}

          {showProjectSettings ? (
            <div className="project-settings-panel">
              <section className="codex-projects-panel" aria-label="Codex projects">
                <div className="codex-projects-header">
                  <p className="section-label">Codex Projects</p>
                  <button
                    disabled={isLoadingCodexProjects}
                    onClick={loadCodexProjects}
                    type="button"
                  >
                    Refresh
                  </button>
                </div>
                <div className="codex-project-list">
                  {codexProjects.map((project) => (
                    <div
                      className={`codex-project-row ${project.tracked ? 'tracked' : ''} ${
                        project.exists ? '' : 'missing'
                      }`}
                      key={project.path}
                    >
                      <div>
                        <strong>{project.name}</strong>
                        <code>{project.path}</code>
                        <span>
                          {project.tracked
                            ? 'Already added'
                            : project.exists
                              ? project.branch
                              : 'Folder missing'}
                        </span>
                      </div>
                      <button
                        disabled={
                          project.tracked ||
                          !project.exists ||
                          addingCodexProjectPath === project.path
                        }
                        onClick={() => addCodexProject(project)}
                        type="button"
                      >
                        {project.tracked
                          ? 'Added'
                          : addingCodexProjectPath === project.path
                            ? 'Adding'
                            : 'Add'}
                      </button>
                    </div>
                  ))}
                  {codexProjects.length === 0 ? (
                    <p className="codex-project-empty">No Codex projects found.</p>
                  ) : null}
                </div>
              </section>
            </div>
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
          <div className="sync-scope" aria-label="GitHub sync scope">
            <span>Sync scope</span>
            <strong>All projects</strong>
            <code>issues/</code>
            <p>GitHub actions pull and push the shared Codex Companion issue store.</p>
          </div>
          <form className="sync-remote-form" onSubmit={connectGitRemote}>
            <input
              aria-label="GitHub remote URL"
              onChange={(event) => setGitRemoteUrl(event.target.value)}
              placeholder="git@github.com:user/issues.git"
              value={gitRemoteUrl}
            />
            <button disabled={syncState.tone === 'working' || isConnectingGit} type="submit">
              Connect
            </button>
          </form>
          {pendingSshAction ? (
            <form
              className="ssh-passphrase-form"
              onSubmit={(event) => {
                event.preventDefault()
                runSync(pendingSshAction)
              }}
            >
              <label>
                <span>SSH key passphrase</span>
                <input
                  autoComplete="current-password"
                  onChange={(event) => setSshPassphrase(event.target.value)}
                  placeholder="Enter once to retry"
                  type="password"
                  value={sshPassphrase}
                />
              </label>
              <button disabled={syncState.tone === 'working' || !sshPassphrase.trim()} type="submit">
                Retry {pendingSshAction === 'all' ? 'Sync' : pendingSshAction === 'pull' ? 'Pull' : 'Push'}
              </button>
            </form>
          ) : null}
          <div className="sync-actions" aria-label="GitHub sync actions">
            <button
              className="primary-sync"
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('all')}
              type="button"
              title="Commit, pull, and push the shared issue store for all projects"
            >
              Sync
            </button>
            <button
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('pull')}
              type="button"
              title="Pull the shared issue store for all projects from GitHub"
            >
              Pull
            </button>
            <button
              disabled={syncState.tone === 'working'}
              onClick={() => runSync('push')}
              type="button"
              title="Commit and push the shared issue store for all projects to GitHub"
            >
              Push
            </button>
          </div>
          {syncState.output ? <pre className="sync-output">{syncState.output}</pre> : null}
        </div>
      </aside>

      <section className="issue-pane" aria-label="Issues">
        <header className="pane-header">
          <div>
            <p className="eyebrow">
              {paneMode === 'workbench'
                ? `${queueCounts.user} user added · ${queueCounts.codex} Codex`
                : paneMode === 'project'
                ? (
                    <span className="branch-eyebrow">
                      Branch: {selectedProject?.branch ?? 'Loading'}
                    </span>
                  )
                : paneMode === 'codex'
                  ? `${queueCounts.codexInProgress} in progress`
                  : `${queueCounts.userSnags} snags`}
            </p>
            <h2>
              {paneMode === 'workbench'
                ? 'Workbench'
                : paneMode === 'project'
                ? selectedProject?.name ?? 'Projects'
                : paneMode === 'codex'
                  ? 'Codex Queue'
                  : 'User Added'}
            </h2>
          </div>
          <div className="header-tools">
            <button
              aria-label="Refresh Codex Companion"
              className="refresh-button"
              disabled={isRefreshing || isLoading}
              onClick={refreshWorkbench}
              title="Refresh projects, issues, queues, and GitHub status"
              type="button"
            >
              ↻
            </button>
            <div className="view-switcher" aria-label="Issue views">
              <button
                className={paneMode === 'workbench' ? 'active' : ''}
                onClick={() => setPaneMode('workbench')}
                type="button"
              >
                Workbench
              </button>
              <button
                className={paneMode === 'project' ? 'active' : ''}
                onClick={() => setPaneMode('project')}
                type="button"
              >
                Project
              </button>
              <button
                className={paneMode === 'codex' ? 'active' : ''}
                onClick={() => setPaneMode('codex')}
                type="button"
              >
                Codex {queueCounts.codex}
              </button>
              <button
                className={paneMode === 'user' ? 'active' : ''}
                onClick={() => setPaneMode('user')}
                type="button"
              >
                User added {queueCounts.user}
              </button>
            </div>
            <label className="search-field">
              <span>Search issues</span>
              <input
                aria-label="Search issues"
                disabled={paneMode === 'project' && !selectedProject}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search title, file, status..."
                type="search"
                value={searchQuery}
              />
            </label>
            <div className="codex-state">
              <span className="blue-dot"></span>
              {paneMode === 'project' ? 'Codex is watching this project' : 'Queue spans active projects'}
            </div>
          </div>
        </header>

        {appError ? <div className="error-banner">{appError}</div> : null}

        {paneMode === 'workbench' ? (
          <div className="workbench-layout">
            <section className="queue-card">
              <div className="queue-card-header">
                <div>
                  <h3>User Added tasks and issues</h3>
                  <p>Snags, tweaks, and future ideas.</p>
                </div>
                <span>{queueCounts.user}</span>
              </div>
              <div className="queue-card-list">
                {userQueueIssues.map((issue) => (
                  <button
                    className={`queue-item ${issue.status} ${issue.id === selectedIssue?.id ? 'selected' : ''}`}
                    key={issue.id}
                    onClick={() => openQueueIssue(issue)}
                    type="button"
                  >
                    <span className="queue-check" aria-hidden="true"></span>
                    <span className="queue-main">
                      <strong>{issue.title}</strong>
                      <code>{issue.file ?? issue.projectName}</code>
                    </span>
                    <span className={`category-pill ${issue.category}`}>{categoryLabels[issue.category]}</span>
                    <span className="queue-age">{formatDate(issue.createdAt)}</span>
                  </button>
                ))}
                {userQueueIssues.length === 0 ? (
                  <div className="queue-empty">No user-added items are waiting.</div>
                ) : null}
              </div>
            </section>

            <section className="queue-card">
              <div className="queue-card-header">
                <div>
                  <h3>Codex Queue</h3>
                  <p>Work items for Codex to pick up.</p>
                </div>
                <span>{queueCounts.codex}</span>
              </div>
              <div className="queue-card-list">
                {codexQueueIssues.map((issue) => (
                  <button
                    className={`queue-item ${issue.status} ${issue.id === selectedIssue?.id ? 'selected' : ''}`}
                    key={issue.id}
                    onClick={() => openQueueIssue(issue)}
                    type="button"
                  >
                    <span className="queue-check" aria-hidden="true"></span>
                    <span className="queue-main">
                      <strong>{issue.title}</strong>
                      <code>{issue.file ?? issue.projectName}</code>
                    </span>
                    <span className={`category-pill ${issue.category}`}>{categoryLabels[issue.category]}</span>
                    <span className="queue-age">{statusLabels[issue.status]}</span>
                  </button>
                ))}
                {codexQueueIssues.length === 0 ? (
                  <div className="queue-empty">No Codex queue items are waiting.</div>
                ) : null}
              </div>
            </section>

            <section className="sync-history-card">
              <div className="queue-card-header">
                <div>
                  <h3>GitHub Sync History</h3>
                  <p>{syncState.remoteUrl || gitRemoteUrl || 'No remote connected'}</p>
                </div>
                <span>{syncState.tone === 'error' ? 'Action needed' : 'Ready'}</span>
              </div>
              <div className="sync-history-grid">
                <div className="sync-history-row current">
                  <span>Now</span>
                  <span>{syncState.message}</span>
                  <strong>{syncState.timestamp ? formatTime(syncState.timestamp) : 'Pending'}</strong>
                </div>
                {syncHistory.map((event) => (
                  <div className="sync-history-row" key={event.id}>
                    <span>{event.createdAt ? formatDate(event.createdAt) : 'Git'}</span>
                    <span>
                      {event.title}
                      {event.detail ? <small>{event.detail}</small> : null}
                    </span>
                    <strong>{event.status}</strong>
                  </div>
                ))}
                {syncHistory.length === 0 ? (
                  <div className="sync-history-empty">No Git history found for this issue store yet.</div>
                ) : null}
              </div>
            </section>
          </div>
        ) : paneMode === 'project' ? (
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
        ) : null}

        {paneMode !== 'workbench' ? (
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
          {paneMode === 'project' ? (
            <>
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
            </>
          ) : null}
          </div>
        ) : null}

        {paneMode !== 'workbench' ? (
          <div className="issue-list">
          {(paneMode === 'project' ? filteredIssues : filteredQueueIssues).map((issue) => (
            paneMode === 'project' ? (
              <div
                className={`issue-row ${issue.status} ${issue.id === selectedIssue?.id ? 'selected' : ''}`}
                key={issue.id}
                onClick={() => setSelectedIssueId(issue.id)}
                role="button"
                tabIndex={0}
              >
                <span className="status-glyph" aria-hidden="true"></span>
                <span className="issue-time">{formatDate(issue.createdAt)}</span>
                <span className="issue-title">{issue.title}</span>
                <span className={`category-pill ${issue.category}`}>
                  {categoryLabels[issue.category]}
                </span>
                <span className="issue-file">{issue.file ?? 'Project note'}</span>
                <span className="issue-source">{issue.source}</span>
                {renderDecisionControls(issue)}
              </div>
            ) : (
              <div
                className={`issue-row queue-row ${issue.status} ${issue.id === selectedIssue?.id ? 'selected' : ''}`}
                key={issue.id}
                onClick={() => openQueueIssue(issue as QueueIssue)}
                role="button"
                tabIndex={0}
              >
                <span className="status-glyph" aria-hidden="true"></span>
                <span className="issue-time">{formatDate(issue.createdAt)}</span>
                <span className="issue-title">{issue.title}</span>
                <span className={`category-pill ${issue.category}`}>
                  {categoryLabels[issue.category]}
                </span>
                <span className="issue-file">{(issue as QueueIssue).projectName}</span>
                <span className="issue-source">{issue.status === 'in-progress' ? 'Active' : issue.source}</span>
                {renderDecisionControls(issue)}
              </div>
            )
          ))}
          {!isLoading && (paneMode === 'project' ? filteredIssues : filteredQueueIssues).length === 0 ? (
            <div className="empty-state">
              <p>
                {paneMode === 'project'
                  ? issues.length
                    ? 'No issues match these filters.'
                    : 'No issues in this project yet.'
                  : paneMode === 'codex'
                    ? 'No Codex-added queue items match these filters.'
                    : 'No user-added queue items match these filters.'}
              </p>
              {(paneMode === 'project' ? issues.length : queueIssues.length) ? (
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
        ) : null}
      </section>

      <aside className="detail-panel" aria-label="Issue details">
        {selectedIssue && detailProject ? (
          <>
            <form className="detail-form" onSubmit={saveIssueDetails}>
              <div className="detail-header">
                <p className="eyebrow">{formatDate(selectedIssue.createdAt)}</p>
                <label className="detail-field title-field">
                  <span>Issue name</span>
                  <textarea
                    onChange={(event) => setEditTitle(event.target.value)}
                    rows={2}
                    value={editTitle}
                  />
                </label>
                <span className={`status-pill ${selectedIssue.status}`}>{statusLabels[selectedIssue.status]}</span>
              </div>

              <div className="detail-context" aria-label="Issue context">
                <div>
                  <span>Source</span>
                  <strong>{selectedIssue.source}</strong>
                </div>
                <div>
                  <span>Project</span>
                  <strong>{selectedIssueQueueContext?.projectName ?? detailProject.name}</strong>
                </div>
                <div>
                  <span>Category</span>
                  <strong>{categoryLabels[selectedIssue.category]}</strong>
                </div>
                <code>{selectedIssue.file || selectedIssueQueueContext?.projectPath || detailProject.path}</code>
              </div>

              <div className={`detail-queue-note ${selectedIssue.source.toLowerCase()}`}>
                {selectedIssue.source === 'User'
                  ? 'User-added item. Codex should check this against current work and pick it up when it fits the active project.'
                  : 'Codex-created item. Keep the status moving so the workbench reflects what Codex is actively handling.'}
              </div>

              <button
                className="ask-codex-button"
                disabled={selectedIssue.status === 'fixed'}
                onClick={() => askCodexToWorkNow(selectedIssue)}
                type="button"
              >
                Ask Codex: Work Now
              </button>

              <label className="detail-field">
                <span>Location</span>
                <input
                  onChange={(event) => setEditFile(event.target.value)}
                  placeholder={detailProject.path}
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
      {toast ? (
        <div className={`app-toast ${toast.tone}`} role="status">
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
            type="button"
          >
            ×
          </button>
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </div>
      ) : null}
    </main>
  )
}

export default App
