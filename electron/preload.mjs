import electron from 'electron'

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('codexCompanion', {
  chooseIssueFolder: () => ipcRenderer.invoke('codex-companion:choose-issue-folder'),
})
