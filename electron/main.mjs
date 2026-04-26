import electron from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startIssueApiServer } from '../server/api.js'

const { app, BrowserWindow } = electron
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appName = 'Codex Companion'
let apiServer

if (!app || !BrowserWindow) {
  throw new Error('Electron main process must be started with the electron runtime.')
}

function createWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#18191d',
    height: 860,
    minHeight: 680,
    minWidth: 1080,
    title: appName,
    width: 1280,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    window.loadURL(devUrl)
    return
  }

  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  app.setName(appName)
  const defaultDataRoot = path.join(app.getPath('appData'), appName)
  mkdirSync(defaultDataRoot, { recursive: true })
  // First-run setup will use this folder for cloned or selected issue data.
  process.env.ISSUE_ROOT_DIR = process.env.ISSUE_ROOT_DIR ?? path.join(__dirname, '..')
  process.env.CODEX_COMPANION_DATA_DIR = process.env.CODEX_COMPANION_DATA_DIR ?? defaultDataRoot
  apiServer = startIssueApiServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  apiServer?.close()
})
