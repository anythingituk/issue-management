import electron from 'electron'

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('codexCompanion', {
  chooseFolder: (options = {}) => ipcRenderer.invoke('codex-companion:choose-folder', options),
  chooseIssueFolder: () =>
    ipcRenderer.invoke('codex-companion:choose-folder', {
      buttonLabel: 'Use folder',
      title: 'Choose Codex Companion issue data folder',
    }),
})
