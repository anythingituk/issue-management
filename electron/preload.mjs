import electron from 'electron'

const { contextBridge, ipcRenderer } = electron
const apiBaseUrlArgument = process.argv.find((argument) =>
  argument.startsWith('--codex-companion-api-base-url='),
)
const apiBaseUrl = apiBaseUrlArgument?.split('=').slice(1).join('=') ?? 'http://localhost:8787'

contextBridge.exposeInMainWorld('codexCompanion', {
  apiBaseUrl,
  chooseFolder: (options = {}) => ipcRenderer.invoke('codex-companion:choose-folder', options),
  chooseIssueFolder: () =>
    ipcRenderer.invoke('codex-companion:choose-folder', {
      buttonLabel: 'Use folder',
      title: 'Choose Codex Companion issue data folder',
    }),
})
