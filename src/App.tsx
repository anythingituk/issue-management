import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent } from 'react'
import './App.css'

type IssueStatus = 'open' | 'in-progress' | 'ready-for-review' | 'fixed' | 'deferred'
type IssueSource = 'Codex' | 'User'
type IssueCategory = 'bug' | 'snag' | 'feature' | 'refactor' | 'docs' | 'testing' | 'question'
type IssueDecision = 'approved' | 'waiting' | 'ignored'
type IssuePriority = 'soon' | 'later'
type StatusFilter = IssueStatus | 'all'
type CategoryFilter = IssueCategory | 'all'
type SourceFilter = IssueSource | 'all'
type SyncAction = 'pull' | 'push' | 'all'
type ResizePane = 'project' | 'detail'
type AutomationPolicy = 'approved-or-soon' | 'approved-only' | 'soon-only' | 'codex-or-approved-user' | 'all'
type Toast = {
  id: string
  message: string
  title: string
  tone: 'info' | 'success' | 'warning'
}

const projectSidebarBounds = {
  default: 260,
  max: 420,
  min: 220,
}
const detailPanelBounds = {
  default: 340,
  max: 560,
  min: 300,
}
const appVersion = import.meta.env.VITE_APP_VERSION ?? '0.1.0'
const releaseChannel = import.meta.env.VITE_RELEASE_CHANNEL ?? 'ALPHA'
const minimumIssuePaneWidth = 560
const resizeHandleWidth = 12
const automationIntervals = [5, 15, 30, 60] as const
const automationPolicyLabels: Record<AutomationPolicy, string> = {
  'approved-or-soon': 'Approved or soon',
  'approved-only': 'Approved only',
  'soon-only': 'Action soon only',
  'codex-or-approved-user': 'Codex or approved user',
  all: 'All queued tasks',
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const value = window.localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}

function readStoredInterval(key: string, fallback: number) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const value = Number(window.localStorage.getItem(key))
  return automationIntervals.includes(value as (typeof automationIntervals)[number]) ? value : fallback
}

function readStoredAutomationPolicy(key: string, fallback: AutomationPolicy) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const value = window.localStorage.getItem(key) as AutomationPolicy | null
  return value && automationPolicyLabels[value] ? value : fallback
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
  automationChangedFiles?: string
  automationCompletedAt?: string
  title: string
  file?: string
  status: IssueStatus
  decision: IssueDecision
  priority?: IssuePriority
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

type AiState = {
  connected: boolean
  model?: string
}

type AiIssueSuggestion = {
  title: string
  detail: string
  category: IssueCategory
  priority: IssuePriority
}

type AutomationRun = {
  changedFiles?: string
  finishedAt?: string
  issueId: string
  output?: string
  policy?: AutomationPolicy
  projectId: string
  projectName: string
  projectPath: string
  startedAt: string
  status: 'running' | 'canceling' | 'completed' | 'failed' | 'canceled'
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
  'ready-for-review': 'Ready for review',
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

const priorityLabels: Record<IssuePriority, string> = {
  soon: 'Action soon',
  later: 'Action later',
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
  const [newIssueDetail, setNewIssueDetail] = useState('')
  const [newIssueFile, setNewIssueFile] = useState('')
  const [newIssueProjectId, setNewIssueProjectId] = useState('')
  const [newIssueCategory, setNewIssueCategory] = useState<IssueCategory>('snag')
  const [newIssuePriority, setNewIssuePriority] = useState<IssuePriority>('later')
  const [isAddIssueModalOpen, setIsAddIssueModalOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectBranch, setNewProjectBranch] = useState('main')
  const [isAddingProject, setIsAddingProject] = useState(false)
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
  const [aiState, setAiState] = useState<AiState>({ connected: false })
  const [openAiApiKey, setOpenAiApiKey] = useState('')
  const [isConnectingAi, setIsConnectingAi] = useState(false)
  const [isSuggestingTitle, setIsSuggestingTitle] = useState(false)
  const [isAssistingIssue, setIsAssistingIssue] = useState(false)
  const [projectSidebarWidth, setProjectSidebarWidth] = useState(() =>
    readStoredWidth(
      'codex-companion-project-sidebar-width',
      projectSidebarBounds.default,
      projectSidebarBounds.min,
      projectSidebarBounds.max,
    ),
  )
  const [detailPanelWidth, setDetailPanelWidth] = useState(() =>
    readStoredWidth(
      'codex-companion-detail-panel-width',
      detailPanelBounds.default,
      detailPanelBounds.min,
      detailPanelBounds.max,
    ),
  )
  const [syncState, setSyncState] = useState<SyncState>({
    tone: 'ready',
    message: 'Checking GitHub sync...',
  })
  const [syncHistory, setSyncHistory] = useState<SyncEvent[]>([])
  const [sshPassphrase, setSshPassphrase] = useState('')
  const [pendingSshAction, setPendingSshAction] = useState<SyncAction | null>(null)
  const [automationRun, setAutomationRun] = useState<AutomationRun | null>(null)
  const [isStartingAutomation, setIsStartingAutomation] = useState(false)
  const [isAutoRunEnabled, setIsAutoRunEnabled] = useState(() =>
    readStoredBoolean('codex-companion-auto-run-enabled', false),
  )
  const [autoRunIntervalMinutes, setAutoRunIntervalMinutes] = useState(() =>
    readStoredInterval('codex-companion-auto-run-interval-minutes', 15),
  )
  const [automationPolicy, setAutomationPolicy] = useState<AutomationPolicy>(() =>
    readStoredAutomationPolicy('codex-companion-automation-policy', 'approved-or-soon'),
  )
  const [toast, setToast] = useState<Toast | null>(null)

  function showToast(toastContent: Omit<Toast, 'id'>) {
    setToast({
      ...toastContent,
      id: `toast-${Date.now()}`,
    })
  }

  function storePaneWidth(pane: ResizePane, width: number) {
    const storageKey =
      pane === 'project'
        ? 'codex-companion-project-sidebar-width'
        : 'codex-companion-detail-panel-width'
    window.localStorage.setItem(storageKey, String(width))
  }

  function getMaximumPaneWidth(pane: ResizePane) {
    const otherPaneWidth = pane === 'project' ? detailPanelWidth : projectSidebarWidth
    const bounds = pane === 'project' ? projectSidebarBounds : detailPanelBounds
    const maxWidthByViewport =
      window.innerWidth - minimumIssuePaneWidth - resizeHandleWidth - otherPaneWidth

    return Math.max(bounds.min, Math.min(bounds.max, maxWidthByViewport))
  }

  function resizePaneWithKeyboard(pane: ResizePane, direction: -1 | 1) {
    const step = 16

    if (pane === 'project') {
      setProjectSidebarWidth((currentWidth) => {
        const nextWidth = clamp(
          currentWidth + direction * step,
          projectSidebarBounds.min,
          getMaximumPaneWidth('project'),
        )
        storePaneWidth(pane, nextWidth)
        return nextWidth
      })
      return
    }

    setDetailPanelWidth((currentWidth) => {
      const nextWidth = clamp(
        currentWidth + direction * step,
        detailPanelBounds.min,
        getMaximumPaneWidth('detail'),
      )
      storePaneWidth(pane, nextWidth)
      return nextWidth
    })
  }

  function startPaneResize(pane: ResizePane, event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = pane === 'project' ? projectSidebarWidth : detailPanelWidth
    const bounds = pane === 'project' ? projectSidebarBounds : detailPanelBounds
    const maxWidth = getMaximumPaneWidth(pane)

    document.body.classList.add('is-resizing-pane')

    function handlePointerMove(pointerEvent: globalThis.PointerEvent) {
      const deltaX = pointerEvent.clientX - startX
      const nextWidth = clamp(
        pane === 'project' ? startWidth + deltaX : startWidth - deltaX,
        bounds.min,
        maxWidth,
      )

      if (pane === 'project') {
        setProjectSidebarWidth(nextWidth)
      } else {
        setDetailPanelWidth(nextWidth)
      }
    }

    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const deltaX = pointerEvent.clientX - startX
      const nextWidth = clamp(
        pane === 'project' ? startWidth + deltaX : startWidth - deltaX,
        bounds.min,
        maxWidth,
      )

      storePaneWidth(pane, nextWidth)
      document.body.classList.remove('is-resizing-pane')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }

  async function loadProjectList() {
    const payload = await apiJson<{ projects: Project[] }>('/api/projects')

    setProjects(payload.projects)
    setSelectedProjectId((currentProjectId) =>
      payload.projects.some((project) => project.id === currentProjectId)
        ? currentProjectId
        : payload.projects[0]?.id || '',
    )
    setNewIssueProjectId((currentProjectId) =>
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

  async function loadAiStatus() {
    const payload = await apiJson<AiState>('/api/ai/status')
    setAiState(payload)
  }

  async function loadAutomationStatus() {
    const payload = await apiJson<{ run: AutomationRun | null; running: boolean }>('/api/automation/status')
    setAutomationRun(payload.run ?? null)
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
          await loadAiStatus()
          await loadAutomationStatus()
        } else {
          setProjects([])
          setIssues([])
          setQueueIssues([])
          setCodexProjects([])
          setSelectedProjectId('')
          setSelectedIssueId('')
          setAiState({ connected: false })
          setAutomationRun(null)
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

  useEffect(() => {
    if (automationRun?.status !== 'running') {
      return
    }

    const intervalId = window.setInterval(() => {
      loadAutomationStatus().catch(() => undefined)
      loadQueue().catch(() => undefined)
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [automationRun?.status])

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
  const nextAutomationIssue = useMemo(() => {
    const priorityWeight: Record<IssuePriority, number> = { soon: 0, later: 1 }
    const statusWeight: Record<IssueStatus, number> = {
      'in-progress': 0,
      open: 1,
      'ready-for-review': 2,
      deferred: 3,
      fixed: 4,
    }
    const decisionWeight: Record<IssueDecision, number> = { approved: 0, waiting: 1, ignored: 2 }
    const sourceWeight: Record<IssueSource, number> = { Codex: 0, User: 1 }
    const policyAllowsIssue = (issue: QueueIssue) => {
      if (automationPolicy === 'all') {
        return true
      }
      if (automationPolicy === 'approved-only') {
        return issue.decision === 'approved'
      }
      if (automationPolicy === 'soon-only') {
        return issue.priority === 'soon'
      }
      if (automationPolicy === 'codex-or-approved-user') {
        return issue.source === 'Codex' || issue.decision === 'approved'
      }

      return issue.decision === 'approved' || issue.priority === 'soon'
    }

    return [...queueIssues]
      .filter(
        (issue) =>
          issue.status !== 'fixed' &&
          issue.decision !== 'ignored' &&
          !issue.automationCompletedAt &&
          policyAllowsIssue(issue),
      )
      .sort(
        (left, right) =>
          priorityWeight[left.priority ?? 'later'] - priorityWeight[right.priority ?? 'later'] ||
          statusWeight[left.status] - statusWeight[right.status] ||
          decisionWeight[left.decision ?? 'waiting'] - decisionWeight[right.decision ?? 'waiting'] ||
          sourceWeight[left.source] - sourceWeight[right.source] ||
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
      )[0]
  }, [automationPolicy, queueIssues])

  useEffect(() => {
    if (
      !isAutoRunEnabled ||
      !nextAutomationIssue ||
      automationRun?.status === 'running' ||
      isStartingAutomation
    ) {
      return
    }

    const intervalId = window.setInterval(() => {
      if (!document.hidden) {
        runNextAutomationTask({ quiet: true })
      }
    }, autoRunIntervalMinutes * 60 * 1000)

    return () => window.clearInterval(intervalId)
  }, [
    autoRunIntervalMinutes,
    automationRun?.status,
    isAutoRunEnabled,
    isStartingAutomation,
    nextAutomationIssue?.id,
  ])

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

  function resetNewIssueForm() {
    setNewIssueTitle('')
    setNewIssueDetail('')
    setNewIssueFile('')
    setNewIssueCategory('snag')
    setNewIssuePriority('later')
  }

  function openAddIssueModal() {
    setNewIssueProjectId(selectedProject?.id ?? projects[0]?.id ?? '')
    setIsAddIssueModalOpen(true)
  }

  function closeAddIssueModal() {
    setIsAddIssueModalOpen(false)
  }

  function setAutoRunEnabled(nextValue: boolean) {
    setIsAutoRunEnabled(nextValue)
    window.localStorage.setItem('codex-companion-auto-run-enabled', String(nextValue))
  }

  function setStoredAutoRunInterval(nextValue: number) {
    setAutoRunIntervalMinutes(nextValue)
    window.localStorage.setItem('codex-companion-auto-run-interval-minutes', String(nextValue))
  }

  function setStoredAutomationPolicy(nextValue: AutomationPolicy) {
    setAutomationPolicy(nextValue)
    window.localStorage.setItem('codex-companion-automation-policy', nextValue)
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

  async function askCodexToWork(issue: Issue, priority: IssuePriority) {
    const previousIssues = issues
    const previousQueueIssues = queueIssues
    const nextStatus: IssueStatus = priority === 'soon' ? 'in-progress' : 'open'
    const nextActivity = [
      `User asked Codex to ${priorityLabels[priority].toLowerCase()}.`,
      ...issue.activity,
    ]
    const optimisticIssue = {
      ...issue,
      decision: 'approved' as IssueDecision,
      priority,
      status: nextStatus,
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
          priority,
          status: nextStatus,
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
        message:
          priority === 'soon'
            ? 'Marked approved and in progress. Codex can pick this up as a near-term task.'
            : 'Marked approved for later. Codex can defer this until higher-priority work clears.',
        title: 'Codex work request queued',
        tone: 'success',
      })
      await loadQueue()
      await refreshSyncStatus()
    } catch (error) {
      setIssues(previousIssues)
      setQueueIssues(previousQueueIssues)
      setAppError(error instanceof Error ? error.message : 'Unable to ask Codex to work on this.')
      showToast({
        message: error instanceof Error ? error.message : 'Unable to ask Codex to work on this.',
        title: 'Codex request failed',
        tone: 'warning',
      })
    }
  }

  async function runNextAutomationTask(options: { quiet?: boolean } = {}) {
    setIsStartingAutomation(true)

    try {
      const payload = await apiJson<{ run?: AutomationRun; message: string; running: boolean }>(
        '/api/automation/run-next',
        {
          body: JSON.stringify({ policy: automationPolicy }),
          method: 'POST',
        },
      )

      setAutomationRun(payload.run ?? null)
      await loadQueue()
      setAppError('')
      if (!options.quiet || payload.running) {
        showToast({
          message: payload.message,
          title: payload.running ? 'Codex automation started' : 'No task ready',
          tone: payload.running ? 'success' : 'info',
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start Codex automation.'
      setAppError(message)
      if (!options.quiet) {
        showToast({
          message,
          title: 'Automation failed',
          tone: 'warning',
        })
      }
    } finally {
      setIsStartingAutomation(false)
    }
  }

  async function cancelAutomationRun() {
    try {
      const payload = await apiJson<{ run?: AutomationRun; message: string; running: boolean }>(
        '/api/automation/cancel',
        { method: 'POST' },
      )
      setAutomationRun(payload.run ?? null)
      showToast({
        message: payload.message,
        title: 'Automation cancel requested',
        tone: 'info',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to cancel Codex automation.',
        title: 'Cancel failed',
        tone: 'warning',
      })
    }
  }

  async function retryAutomationRun() {
    if (!automationRun) {
      return
    }

    setIsStartingAutomation(true)
    try {
      const payload = await apiJson<{ run?: AutomationRun; message: string; running: boolean }>(
        '/api/automation/retry',
        {
          body: JSON.stringify({ issueId: automationRun.issueId, policy: automationRun.policy ?? automationPolicy }),
          method: 'POST',
        },
      )
      setAutomationRun(payload.run ?? null)
      await loadQueue()
      showToast({
        message: payload.message,
        title: 'Codex automation retried',
        tone: 'success',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to retry Codex automation.',
        title: 'Retry failed',
        tone: 'warning',
      })
    } finally {
      setIsStartingAutomation(false)
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
          priority: selectedIssue.priority,
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
    const targetProject = projects.find((project) => project.id === newIssueProjectId) ?? selectedProject

    if (!title || !targetProject) {
      return
    }

    try {
      const payload = await apiJson<{ issue: Issue }>('/api/issues', {
        body: JSON.stringify({
          projectId: targetProject.id,
          title,
          file: newIssueFile.trim(),
          category: newIssueCategory,
          detail: newIssueDetail.trim(),
          priority: newIssuePriority,
          source: 'User',
        }),
        method: 'POST',
      })

      if (targetProject.id === selectedProject?.id) {
        setIssues((currentIssues) => [payload.issue, ...currentIssues])
      }
      setSelectedIssueId(payload.issue.id)
      resetNewIssueForm()
      setIsAddIssueModalOpen(false)
      setAppError('')
      await loadProjectList()
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
        loadAutomationStatus(),
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
    return /ssh-askpass|permission denied \(publickey\)|could not read from remote repository|command failed: git (pull|push)|sync failed: git (pull|push)|git (pull|push)( --rebase)?$/i.test(
      message,
    )
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

  async function connectOpenAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const apiKey = openAiApiKey.trim()
    if (!apiKey) {
      return
    }

    setIsConnectingAi(true)
    try {
      const payload = await apiJson<AiState>('/api/ai/connect', {
        body: JSON.stringify({ apiKey }),
        method: 'POST',
      })
      setAiState(payload)
      setOpenAiApiKey('')
      showToast({
        message: 'OpenAI is connected for local AI assistance.',
        title: 'AI Assistant connected',
        tone: 'success',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to connect OpenAI.',
        title: 'AI connection failed',
        tone: 'warning',
      })
    } finally {
      setIsConnectingAi(false)
    }
  }

  async function disconnectOpenAi() {
    const confirmed = window.confirm(
      'Disconnect ChatGPT from Codex Companion on this machine? This removes the stored OpenAI API key.',
    )

    if (!confirmed) {
      return
    }

    try {
      const payload = await apiJson<AiState>('/api/ai/disconnect', {
        method: 'POST',
      })
      setAiState(payload)
      showToast({
        message: payload.connected
          ? 'Stored API key removed. An environment OpenAI key is still available.'
          : 'OpenAI API key removed from this machine.',
        title: 'ChatGPT disconnected',
        tone: 'success',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to disconnect ChatGPT.',
        title: 'Disconnect failed',
        tone: 'warning',
      })
    }
  }

  async function suggestIssueTitle() {
    const description = newIssueDetail.trim()

    if (!description) {
      showToast({
        message: 'Enter a description first so AI has something to summarise.',
        title: 'Description needed',
        tone: 'warning',
      })
      return
    }

    setIsSuggestingTitle(true)
    try {
      const payload = await apiJson<{ title: string }>('/api/ai/suggest-title', {
        body: JSON.stringify({
          category: newIssueCategory,
          description,
        }),
        method: 'POST',
      })
      setNewIssueTitle(payload.title)
      showToast({
        message: 'Suggested a concise title from the description.',
        title: 'Title suggested',
        tone: 'success',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to suggest a title.',
        title: 'AI suggestion failed',
        tone: 'warning',
      })
    } finally {
      setIsSuggestingTitle(false)
    }
  }

  async function assistNewIssue() {
    const title = newIssueTitle.trim()
    const description = newIssueDetail.trim()

    if (!title && !description) {
      showToast({
        message: 'Enter a title or description first so AI has something to improve.',
        title: 'Issue text needed',
        tone: 'warning',
      })
      return
    }

    setIsAssistingIssue(true)
    try {
      const payload = await apiJson<AiIssueSuggestion>('/api/ai/assist-issue', {
        body: JSON.stringify({
          category: newIssueCategory,
          description,
          file: newIssueFile.trim(),
          priority: newIssuePriority,
          title,
        }),
        method: 'POST',
      })
      setNewIssueTitle(payload.title)
      setNewIssueDetail(payload.detail)
      setNewIssueCategory(payload.category)
      setNewIssuePriority(payload.priority)
      showToast({
        message: 'Improved the issue title, description, category, and priority.',
        title: 'AI Assist applied',
        tone: 'success',
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : 'Unable to assist with this issue.',
        title: 'AI Assist failed',
        tone: 'warning',
      })
    } finally {
      setIsAssistingIssue(false)
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

  const companionShellStyle = {
    '--detail-panel-width': `${detailPanelWidth}px`,
    '--project-sidebar-width': `${projectSidebarWidth}px`,
  } as CSSProperties

  return (
    <main className="companion-shell" style={companionShellStyle}>
      <aside className="project-sidebar" aria-label="Projects">
        <div className="brand-block">
          <img className="brand-mark" src="codex-companion-icon.png" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow brand-title">Codex Companion</p>
            <p className="brand-subtitle">Control Center</p>
          </div>
        </div>

        <div className="sidebar-section projects-panel">
          <div className="sidebar-section-header">
            <p className="section-label projects-label">Projects</p>
            <button
              aria-expanded={showProjectSettings}
              aria-label="Add project"
              className="project-settings-toggle"
              onClick={() => setShowProjectSettings((isOpen) => !isOpen)}
              title="Add project"
              type="button"
            >
              +
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
            <label className="show-archived-toggle">
              <input
                checked={showArchivedProjects}
                onChange={(event) => setShowArchivedProjects(event.target.checked)}
                type="checkbox"
              />
              <span>Archived</span>
            </label>
          </div>

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
              <form className="add-project-form" onSubmit={addProject}>
                <p className="section-label">Manual Add</p>
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
                    placeholder="/mnt/d/dev/project"
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
                    {isAddingProject ? 'Adding' : 'Add'}
                  </button>
                </div>
              </form>
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
          </div>
          {syncState.output ? <pre className="sync-output">{syncState.output}</pre> : null}
        </div>

        <section className={`ai-panel ${aiState.connected ? 'connected' : ''}`} aria-label="ChatGPT assistant">
          <div className="ai-panel-header">
            <p className="section-label">ChatGPT</p>
            {aiState.connected ? <span>Connected</span> : null}
          </div>
          {aiState.connected ? (
            <div className="ai-connected">
              <p>
                ChatGPT is ready for issue writing assistance.
                {aiState.model ? <small>{aiState.model}</small> : null}
              </p>
              <button className="ai-disconnect-link" onClick={disconnectOpenAi} type="button">
                Disconnect
              </button>
            </div>
          ) : (
            <form className="ai-connect-form" onSubmit={connectOpenAi}>
              <p>Connect OpenAI to enable title suggestions and later writing assistance.</p>
              <input
                autoComplete="off"
                onChange={(event) => setOpenAiApiKey(event.target.value)}
                placeholder="OpenAI API key"
                type="password"
                value={openAiApiKey}
              />
              <button disabled={isConnectingAi || !openAiApiKey.trim()} type="submit">
                {isConnectingAi ? 'Connecting' : 'Connect ChatGPT'}
              </button>
            </form>
          )}
        </section>
      </aside>

      <div
        aria-label="Resize project sidebar"
        aria-orientation="vertical"
        className="pane-resize-handle project-resize-handle"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            resizePaneWithKeyboard('project', -1)
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            resizePaneWithKeyboard('project', 1)
          }
        }}
        onPointerDown={(event) => startPaneResize('project', event)}
        role="separator"
        tabIndex={0}
        title="Drag to resize projects sidebar"
      />

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
            <button
              aria-label="Add issue"
              className="refresh-button add-issue-button"
              disabled={!projects.length}
              onClick={openAddIssueModal}
              title="Add issue or snag"
              type="button"
            >
              +
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

            <section className="automation-card">
              <div className="queue-card-header">
                <div>
                  <h3>Codex Automation</h3>
                  <p>
                    {automationRun
                      ? `${automationRun.status} · ${automationRun.projectName}`
                      : nextAutomationIssue
                        ? `${nextAutomationIssue.projectName} · ${categoryLabels[nextAutomationIssue.category]}`
                        : 'No ready tasks'}
                  </p>
                </div>
                <span>{automationRun?.status ?? 'Ready'}</span>
              </div>
              <div className="automation-card-body">
                <div>
                  <p className="section-label">Next task</p>
                  <strong>{automationRun?.title ?? nextAutomationIssue?.title ?? 'Queue is clear'}</strong>
                  <span>
                    {automationRun
                      ? `${automationRun.finishedAt ? 'Finished' : 'Started'} ${formatTime(automationRun.finishedAt ?? automationRun.startedAt)}`
                      : nextAutomationIssue
                        ? `${nextAutomationIssue.source} · ${priorityLabels[nextAutomationIssue.priority ?? 'later']} · ${automationPolicyLabels[automationPolicy]}`
                        : `No tasks match ${automationPolicyLabels[automationPolicy].toLowerCase()}.`}
                  </span>
                </div>
                <div className="automation-actions">
                  <button
                    disabled={
                      isStartingAutomation ||
                      automationRun?.status === 'running' ||
                      automationRun?.status === 'canceling' ||
                      !nextAutomationIssue
                    }
                    onClick={() => runNextAutomationTask()}
                    type="button"
                  >
                    {automationRun?.status === 'running' || automationRun?.status === 'canceling'
                      ? 'Running'
                      : isStartingAutomation
                        ? 'Starting'
                        : 'Run next task'}
                  </button>
                  {automationRun?.status === 'running' || automationRun?.status === 'canceling' ? (
                    <button
                      className="automation-cancel-button"
                      disabled={automationRun.status === 'canceling'}
                      onClick={cancelAutomationRun}
                      type="button"
                    >
                      {automationRun.status === 'canceling' ? 'Canceling' : 'Cancel run'}
                    </button>
                  ) : null}
                  {automationRun?.status === 'failed' || automationRun?.status === 'canceled' ? (
                    <button
                      disabled={isStartingAutomation}
                      onClick={retryAutomationRun}
                      type="button"
                    >
                      {isStartingAutomation ? 'Retrying' : 'Retry run'}
                    </button>
                  ) : null}
                  <label className="auto-run-interval">
                    <span>Policy</span>
                    <select
                      disabled={automationRun?.status === 'running' || automationRun?.status === 'canceling'}
                      onChange={(event) => setStoredAutomationPolicy(event.target.value as AutomationPolicy)}
                      value={automationPolicy}
                    >
                      {(Object.keys(automationPolicyLabels) as AutomationPolicy[]).map((policy) => (
                        <option key={policy} value={policy}>
                          {automationPolicyLabels[policy]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="auto-run-toggle">
                    <input
                      checked={isAutoRunEnabled}
                      onChange={(event) => setAutoRunEnabled(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Auto-run while open</span>
                  </label>
                  <label className="auto-run-interval">
                    <span>Every</span>
                    <select
                      disabled={!isAutoRunEnabled}
                      onChange={(event) => setStoredAutoRunInterval(Number(event.target.value))}
                      value={autoRunIntervalMinutes}
                    >
                      {automationIntervals.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} min
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              {automationRun?.changedFiles ? (
                <pre className={`automation-output changed-files ${automationRun.status}`}>
                  {`Changed files:\n${automationRun.changedFiles}`}
                </pre>
              ) : null}
              {automationRun?.output ? (
                <pre className={`automation-output ${automationRun.status}`}>{automationRun.output}</pre>
              ) : null}
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

      <div
        aria-label="Resize issue details panel"
        aria-orientation="vertical"
        className="pane-resize-handle detail-resize-handle"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            resizePaneWithKeyboard('detail', 1)
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            resizePaneWithKeyboard('detail', -1)
          }
        }}
        onPointerDown={(event) => startPaneResize('detail', event)}
        role="separator"
        tabIndex={0}
        title="Drag to resize issue details panel"
      />

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

              <label className="detail-field">
                <span>Description</span>
                <textarea
                  onChange={(event) => setEditDetail(event.target.value)}
                  rows={5}
                  value={editDetail}
                />
              </label>

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
                <div>
                  <span>Priority</span>
                  <strong>{priorityLabels[selectedIssue.priority ?? 'later']}</strong>
                </div>
                <code>{selectedIssue.file || selectedIssueQueueContext?.projectPath || detailProject.path}</code>
              </div>

              <div className={`detail-queue-note ${selectedIssue.source.toLowerCase()}`}>
                {selectedIssue.source === 'User'
                  ? 'User-added item. Codex should check this against current work and pick it up when it fits the active project.'
                  : 'Codex-created item. Keep the status moving so the workbench reflects what Codex is actively handling.'}
              </div>

              <div className="ask-codex-actions" aria-label="Ask Codex priority">
                <button
                  className="ask-codex-button"
                  disabled={selectedIssue.status === 'fixed'}
                  onClick={() => askCodexToWork(selectedIssue, 'soon')}
                  type="button"
                >
                  Ask Codex: Action soon
                </button>
                <button
                  className="ask-codex-button secondary"
                  disabled={selectedIssue.status === 'fixed'}
                  onClick={() => askCodexToWork(selectedIssue, 'later')}
                  type="button"
                >
                  Action later
                </button>
              </div>

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

              <button className="save-issue-button" disabled={isSavingIssue} type="submit">
                {isSavingIssue ? 'Saving...' : 'Save changes'}
              </button>
            </form>

            {selectedIssue.status === 'ready-for-review' ? (
              <div className="review-card">
                <p className="section-label">Review required</p>
                <p>
                  Codex automation has finished. Review the project changes, then mark this task
                  fixed when the result is confirmed.
                </p>
                {selectedIssue.automationChangedFiles ? (
                  <pre>{selectedIssue.automationChangedFiles}</pre>
                ) : null}
                <div>
                  <button onClick={() => updateStatus(selectedIssue.id, 'fixed')} type="button">
                    Mark fixed
                  </button>
                  <button onClick={() => updateStatus(selectedIssue.id, 'open')} type="button">
                    Reopen
                  </button>
                </div>
              </div>
            ) : null}

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
      {isAddIssueModalOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeAddIssueModal}>
          <section
            aria-labelledby="add-issue-modal-title"
            aria-modal="true"
            className="add-issue-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-header">
              <div>
                <h2 id="add-issue-modal-title">Add task</h2>
                <p className="modal-helper-text">
                  Choose the category, such as Snag or Refactor, from the dropdown. Write out
                  your prompt in the Prompt/Description box below. If you have set up a ChatGPT
                  API key, you can ask AI to provide a short title.
                </p>
              </div>
              <button
                aria-label="Close add issue dialog"
                className="modal-close-button"
                onClick={closeAddIssueModal}
                type="button"
              >
                ×
              </button>
            </div>
            <form className="quick-add modal-issue-form" onSubmit={addIssue}>
              <label className="modal-project-field">
                <span>Project</span>
                <select
                  aria-label="Project"
                  onChange={(event) => setNewIssueProjectId(event.target.value)}
                  value={newIssueProjectId}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="quick-title-field">
                <input
                  aria-label="Issue title"
                  onChange={(event) => setNewIssueTitle(event.target.value)}
                  placeholder="Short title"
                  value={newIssueTitle}
                />
                <button
                  aria-label="Suggest title from description"
                  disabled={!aiState.connected || !newIssueDetail.trim() || isSuggestingTitle}
                  onClick={suggestIssueTitle}
                  title={
                    aiState.connected
                      ? 'Suggest title from description'
                      : 'Connect ChatGPT to suggest a title'
                  }
                  type="button"
                >
                  {isSuggestingTitle ? '...' : 'AI'}
                </button>
              </div>
              <input
                aria-label="File path"
                onChange={(event) => setNewIssueFile(event.target.value)}
                placeholder="Optional file path"
                value={newIssueFile}
              />
              <select
                aria-label="Issue category"
                onChange={(event) => setNewIssueCategory(event.target.value as IssueCategory)}
                value={newIssueCategory}
              >
                {(Object.keys(categoryLabels) as IssueCategory[]).map((category) => (
                  <option key={category} value={category}>
                    {categoryLabels[category]}
                  </option>
                ))}
              </select>
              <select
                aria-label="Issue priority"
                onChange={(event) => setNewIssuePriority(event.target.value as IssuePriority)}
                value={newIssuePriority}
              >
                {(Object.keys(priorityLabels) as IssuePriority[]).map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityLabels[priority]}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="Issue description"
                onChange={(event) => setNewIssueDetail(event.target.value)}
                placeholder="Type your prompt (or description of task) for Codex to pick up later"
                rows={4}
                value={newIssueDetail}
              />
              <div className="quick-form-actions">
                <button
                  className="quick-ai-assist-button"
                  disabled={
                    !aiState.connected ||
                    (!newIssueTitle.trim() && !newIssueDetail.trim()) ||
                    isAssistingIssue
                  }
                  onClick={assistNewIssue}
                  title={aiState.connected ? 'Improve the draft issue' : 'Connect ChatGPT to use AI Assist'}
                  type="button"
                >
                  {isAssistingIssue ? 'Assisting' : 'AI Assist'}
                </button>
                <button className="modal-secondary-button" onClick={closeAddIssueModal} type="button">
                  Cancel
                </button>
                <button
                  className="quick-save-button"
                  disabled={!newIssueProjectId || !newIssueTitle.trim()}
                  type="submit"
                >
                  Save
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
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
      <footer className="app-status-bar" aria-label="Application status">
        <span>Codex Companion</span>
        <span>v{appVersion}</span>
        <strong>{releaseChannel}</strong>
        <span>Public project</span>
        <a href="https://github.com/anythingituk/issue-management" rel="noreferrer" target="_blank">
          GitHub repo
        </a>
        <span>© 2026 Jonathan Burrows - Anything I.T.</span>
      </footer>
    </main>
  )
}

export default App
