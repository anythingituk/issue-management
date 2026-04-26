import electron from 'electron'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startIssueApiServer } from '../server/api.js'

const { app, BrowserWindow, dialog, ipcMain } = electron
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appName = 'Codex Companion'
const appUserModelId = 'net.anythingit.codex-companion'
let apiServer
let apiBaseUrl = 'http://localhost:8787'
let mainWindow

if (!app || !BrowserWindow) {
  throw new Error('Electron main process must be started with the electron runtime.')
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        findAvailablePort(0).then(resolve, reject)
        return
      }

      reject(error)
    })

    server.once('listening', () => {
      const address = server.address()
      const availablePort = typeof address === 'object' && address ? address.port : preferredPort
      server.close(() => resolve(availablePort))
    })

    server.listen(preferredPort, '127.0.0.1')
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: '#18191d',
    height: 860,
    minHeight: 680,
    minWidth: 1080,
    title: appName,
    width: 1280,
    webPreferences: {
      additionalArguments: [`--codex-companion-api-base-url=${apiBaseUrl}`],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    return
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    app.setName(appName)
    app.setAppUserModelId(appUserModelId)
    ipcMain.handle('codex-companion:choose-folder', async (_event, options = {}) => {
      const result = await dialog.showOpenDialog({
        buttonLabel: options.buttonLabel || 'Use folder',
        properties: ['openDirectory'],
        title: options.title || 'Choose folder',
      })

      return result.canceled ? '' : result.filePaths[0] ?? ''
    })

    const defaultDataRoot = path.join(app.getPath('appData'), appName)
    mkdirSync(defaultDataRoot, { recursive: true })
    process.env.CODEX_COMPANION_DATA_DIR = process.env.CODEX_COMPANION_DATA_DIR ?? defaultDataRoot
    const apiPort = await findAvailablePort(Number(process.env.ISSUE_API_PORT ?? 8787))
    apiBaseUrl = `http://localhost:${apiPort}`
    apiServer = startIssueApiServer({ port: apiPort })
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.focus()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  apiServer?.close()
})
