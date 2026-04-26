import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startIssueApiServer } from '../server/api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let apiServer

function createWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#18191d',
    height: 860,
    minHeight: 680,
    minWidth: 1080,
    title: 'Issue Management',
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
  process.env.ISSUE_ROOT_DIR = process.env.ISSUE_ROOT_DIR ?? path.join(__dirname, '..')
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
