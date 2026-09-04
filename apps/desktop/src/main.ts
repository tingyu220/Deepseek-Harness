import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray, type NativeImage } from 'electron'
// electron-updater 是 CJS 包，ESM 里不能命名导入（运行时报错），必须默认导入再解构。
import updaterPkg from 'electron-updater'
const { autoUpdater } = updaterPkg
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Minimal structural view of the shutdown controller returned by runProfile. */
interface ShutdownHandle {
  shutdown(code: number): Promise<void>
}

const SMOKE = process.argv.includes('--smoke')

let logPath = ''
function log(...args: unknown[]): void {
  const line = args.map(value => String(value)).join(' ')
  console.log(line)
  if (logPath !== '') {
    try { appendFileSync(logPath, line + '\n') } catch { /* best effort */ }
  }
}

function initLog(): void {
  try {
    logPath = join(tmpdir(), 'dsh-desktop.log')
    log('[dsh-desktop] log file:', logPath)
  } catch {
    logPath = ''
  }
}

/** Pick a free loopback port instead of pinning the web default (3080). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/** Poll the web surface until the host answers, bounding boot on a timeout. */
function waitForHttp(url: string, timeoutMs = 60_000): Promise<number> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const req = request(url, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`[dsh-desktop] timeout waiting for ${url}`))
        else setTimeout(poll, 250)
      })
      req.setTimeout(2000, () => req.destroy())
      req.end()
    }
    poll()
  })
}

let shutdown: ShutdownHandle | undefined
let quitting = false
let tray: Tray | undefined

async function quitApp(code: number): Promise<void> {
  if (quitting) return
  quitting = true
  try {
    await shutdown?.shutdown(code)
  } finally {
    app.exit(code)
  }
}

/** Bring the shell window back from minimize or the tray. */
function focusWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (win !== undefined) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/**
 * Rasterize the DeepSeek whale logo (favicon.svg) into a tray icon. The
 * favicon is SVG and the tray needs a raster image, so render it in a tiny
 * hidden window and capture it. Falls back to an empty image so the tray
 * still works if rendering fails.
 */
async function createWhaleTrayIcon(): Promise<NativeImage> {
  try {
    const svgPath = join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'public', 'favicon.svg')
    let svg = readFileSync(svgPath, 'utf8')
    // Drop the dark-mode media query (it would repaint the whale white) and
    // pin the DeepSeek brand blue so the tray icon reads on light and dark
    // taskbars alike.
    svg = svg.replace(/<style>[\s\S]*?<\/style>/, '')
    svg = svg.replace('fill="#000"', 'fill="#4D6BFE"')
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{width:32px;height:32px;display:block}</style></head><body>${svg}</body></html>`
    const iconWin = new BrowserWindow({
      width: 32,
      height: 32,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    try {
      await iconWin.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
      await new Promise(resolve => setTimeout(resolve, 250))
      const image = await iconWin.webContents.capturePage({ x: 0, y: 0, width: 32, height: 32 })
      if (!image.isEmpty()) return image
    } finally {
      iconWin.destroy()
    }
  } catch (error) {
    log('[dsh-desktop] whale tray icon render failed:', error instanceof Error ? error.message : String(error))
  }
  return nativeImage.createEmpty()
}

/** Manual update check with user-facing feedback for every outcome. */
async function manualCheckUpdate(): Promise<void> {
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result === null || !result.isUpdateAvailable) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本（v${app.getVersion()}）`,
        buttons: ['确定'],
      })
    } else {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `发现新版本 v${result.updateInfo.version}，正在后台下载，完成后会提示重启。`,
        buttons: ['确定'],
      })
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'warning',
      title: '检查更新',
      message: '检查更新失败，请稍后重试。',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['确定'],
    })
  }
}

async function boot(): Promise<void> {
  // The dsh host (cordis-plugin-hmr) resolves process.argv[1]; a packaged
  // Electron app has no script argument (argv[1] is undefined), so provide
  // the app directory so plugin root resolution stays valid.
  if (process.argv[1] === undefined) process.argv[1] = app.getAppPath()

  const port = await getFreePort()
  const url = `http://127.0.0.1:${port}`
  log('[dsh-desktop] booting web surface at', url)

  const watchdog = setTimeout(() => {
    log('[dsh-desktop] WATCHDOG: runProfile still pending after 30s')
    const handles = (process as { _getActiveHandles?: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles?.() ?? []
    log('[dsh-desktop] active handle count:', handles.length)
    log('[dsh-desktop] active handles:', handles.map(handle => handle.constructor?.name ?? 'unknown').join(', '))
  }, 30_000)

  const booted = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    args: ['--port', String(port)],
  })
  clearTimeout(watchdog)
  shutdown = booted.shutdown
  log('[dsh-desktop] runProfile resolved')

  await waitForHttp(url)
  log('[dsh-desktop] web surface ready at', url)

  if (SMOKE) {
    await quitApp(0)
    return
  }

  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  // System tray: closing the window hides it to the tray instead of quitting,
  // so an accidental close does not tear down an in-flight session.
  tray = new Tray(await createWhaleTrayIcon())
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DeepSeek Harness', click: () => focusWindow() },
    { label: '检查更新', click: () => { void manualCheckUpdate() } },
    { type: 'separator' },
    { label: '退出', click: () => { void quitApp(0) } },
  ]))
  tray.on('click', () => focusWindow())
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // electron-updater: download updates in the background and install on quit.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    void dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: `新版本 v${info.version} 已下载完成。`,
      detail: '重启后自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) void quitApp(0)
    })
  })
  autoUpdater.on('error', (error) => {
    log('[dsh-desktop] auto-update error:', error instanceof Error ? error.message : String(error))
  })

  await win.loadURL(url)
  log('[dsh-desktop] window loaded', url)

  // Non-blocking startup update check.
  void autoUpdater.checkForUpdates().catch((error) => {
    log('[dsh-desktop] update check failed:', error instanceof Error ? error.message : String(error))
  })
}

initLog()
log('[dsh-desktop] module loaded')

const hasLock = app.requestSingleInstanceLock()
log('[dsh-desktop] hasLock =', hasLock)

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusWindow()
  })

  void app.whenReady().then(() => {
    boot().catch((error: unknown) => {
      log('[dsh-desktop] boot failed:', error instanceof Error ? (error.stack ?? String(error)) : String(error))
      void quitApp(1)
    })
  })

  app.on('window-all-closed', () => {
    void quitApp(0)
  })
}
