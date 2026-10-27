import { app, net, shell, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import log from 'share/common/log'
import { t } from 'common/util'
import {
  IUpdateAsset,
  IUpdateRelease,
  IUpdateState,
  UpdatePhase,
} from 'common/types'
import { handleEvent } from './util'
import * as window from './window'
import * as updates from '../../../main/window/updates'

const logger = log('updater')

// 更新发布在本分支的 GitHub Releases 上。
// 这里直接读 GitHub API，而不使用 electron-updater：
// electron-updater 的 GitHub provider 要求 Release 里带 latest.yml，
// 缺失时会直接抛错，导致“检查版本失败”。
const RELEASES_API =
  'https://api.github.com/repos/foryouos/aya-mcp/releases?per_page=30'
export const RELEASES_PAGE = 'https://github.com/foryouos/aya-mcp/releases'
const REQUEST_TIMEOUT = 15000
const MAX_NOTES_LENGTH = 12000

interface IGithubAsset {
  name?: string
  size?: number
  browser_download_url?: string
}

interface IGithubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: IGithubAsset[]
}

const state: IUpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  asset: null,
  release: null,
  hasUpdate: false,
  progress: 0,
  received: 0,
  total: 0,
  downloadedPath: '',
  error: '',
  checkedAt: 0,
}

let controller: AbortController | null = null
let downloading = false
// 同一次运行中同一个版本只提醒一次，避免静默检查反复打扰
let notifiedVersion = ''

// 只认 x.y.z 形式的 tag（可带 v 前缀），
// 带后缀的测试 tag（如 x.y.z.Test）不参与版本比较。
function parseVersion(tag: string): number[] | null {
  const match = /^[vV]?(\d+(?:\.\d+)*)$/.exec(tag.trim())
  if (!match) return null

  return match[1].split('.').map((part) => parseInt(part, 10))
}

function compareVersion(a: number[], b: number[]) {
  const len = Math.max(a.length, b.length)

  for (let i = 0; i < len; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x - y
  }

  return 0
}

// 当前平台对应的安装包后缀
function getAssetExt() {
  switch (process.platform) {
    case 'win32':
      return '.exe'
    case 'darwin':
      return '.dmg'
    default:
      return '.appimage'
  }
}

function pickAsset(assets: IUpdateAsset[]): IUpdateAsset | null {
  const ext = getAssetExt()
  const candidates = assets.filter((item) =>
    item.name.toLowerCase().endsWith(ext),
  )
  if (!candidates.length) return null

  // 优先匹配当前架构（x64 / arm64 / ia32），否则取第一个
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const matched = candidates.find((item) =>
    item.name.toLowerCase().includes(arch.toLowerCase()),
  )

  return matched || candidates[0]
}

function normalizeNotes(body?: string) {
  if (!body) return ''
  const notes = body.replace(/\r\n/g, '\n').trim()
  return notes.length > MAX_NOTES_LENGTH
    ? `${notes.slice(0, MAX_NOTES_LENGTH)}\n...`
    : notes
}

function toRelease(raw: IGithubRelease, version: string): IUpdateRelease {
  const assets: IUpdateAsset[] = []
  for (const item of raw.assets || []) {
    if (!item.name || !item.browser_download_url) continue
    assets.push({
      name: item.name,
      size: item.size || 0,
      url: item.browser_download_url,
    })
  }

  return {
    version,
    name: raw.name || raw.tag_name || version,
    notes: normalizeNotes(raw.body),
    url: raw.html_url || RELEASES_PAGE,
    publishedAt: raw.published_at || '',
    assets,
  }
}

async function fetchLatestRelease(): Promise<IUpdateRelease | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT)

  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `AYA/${app.getVersion()}`,
      },
      signal: abort.signal,
    })

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}`)
    }

    const releases = (await res.json()) as IGithubRelease[]
    if (!Array.isArray(releases)) {
      throw new Error('invalid response')
    }

    let latest: { version: string; raw: IGithubRelease } | null = null
    let latestParsed: number[] | null = null

    for (const raw of releases) {
      if (raw.draft || raw.prerelease || !raw.tag_name) continue

      const parsed = parseVersion(raw.tag_name)
      if (!parsed) continue

      if (!latestParsed || compareVersion(parsed, latestParsed) > 0) {
        latestParsed = parsed
        latest = { version: parsed.join('.'), raw }
      }
    }

    return latest ? toRelease(latest.raw, latest.version) : null
  } finally {
    clearTimeout(timer)
  }
}

function broadcast() {
  window.sendAll('updateState', getState())
}

export function getState(): IUpdateState {
  return { ...state }
}

function resetDownloadState() {
  state.progress = 0
  state.received = 0
  state.total = state.asset ? state.asset.size : 0
  state.downloadedPath = ''
}

function toErrorMessage(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err || '')

  if (/abort/i.test(message)) {
    return t('updateErrTimeout')
  }
  if (/40[13]|429/.test(message)) {
    return t('updateErrRateLimit')
  }

  return message || fallback
}

function setPhase(phase: UpdatePhase) {
  state.phase = phase
  broadcast()
}

// 主窗口可见时用页面内提醒，隐藏到托盘时用系统通知
function notifyAvailable() {
  const release = state.release
  if (!release || notifiedVersion === release.version) return

  const mainWin = window.getWin('main')
  if (
    mainWin &&
    !mainWin.isDestroyed() &&
    mainWin.isVisible() &&
    !mainWin.isMinimized()
  ) {
    return
  }

  if (!Notification.isSupported()) return

  notifiedVersion = release.version

  try {
    const notification = new Notification({
      title: `${app.getName()} ${release.version}`,
      body: t('updateNewVersionToast', { version: release.version }),
    })
    notification.on('click', () => updates.showWin())
    notification.show()
  } catch (err) {
    logger.warn('notify update failed', err)
  }
}

export async function checkUpdate(options: { silent?: boolean } = {}) {
  const silent = !!options.silent

  if (state.phase === 'checking' || downloading) {
    return getState()
  }

  state.error = ''
  if (state.phase !== 'downloaded') {
    resetDownloadState()
  }
  setPhase('checking')

  try {
    const current = parseVersion(app.getVersion())
    if (!current) {
      throw new Error(`invalid current version ${app.getVersion()}`)
    }

    const release = await fetchLatestRelease()
    state.checkedAt = Date.now()

    if (!release) {
      state.release = null
      state.asset = null
      state.hasUpdate = false
      resetDownloadState()
      setPhase('latest')
      logger.info('no release found, treat as latest')
      return getState()
    }

    const latest = parseVersion(release.version)
    const hasUpdate = !!latest && compareVersion(latest, current) > 0

    state.release = release
    state.asset = pickAsset(release.assets)
    state.hasUpdate = hasUpdate
    resetDownloadState()

    if (hasUpdate) {
      logger.info('update available', release.version)
      setPhase('available')
      notifyAvailable()
    } else {
      logger.info('already latest', current.join('.'))
      setPhase('latest')
    }
  } catch (err) {
    logger.error(
      'check update failed',
      err instanceof Error ? err.message : err,
    )
    state.error = toErrorMessage(err, t('updateErr'))
    setPhase('error')
    if (silent) {
      logger.info('silent check failed, ignore')
    }
  }

  return getState()
}

function getDownloadDir() {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('userData')
  }
}

export async function downloadUpdate() {
  if (state.phase === 'downloading') return getState()

  const asset = state.asset
  if (!asset) {
    // 没有对应平台的安装包时退回浏览器下载
    if (state.release) {
      shell.openExternal(state.release.url)
    }
    return getState()
  }

  const dir = getDownloadDir()
  const dest = path.resolve(dir, asset.name)

  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch {
    // 目录已存在或无权限时交给写入流程报错
  }

  controller = new AbortController()
  downloading = true
  state.error = ''
  state.downloadedPath = ''
  state.received = 0
  state.progress = 0
  state.total = asset.size || 0
  setPhase('downloading')

  try {
    const res = await net.fetch(asset.url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }

    const contentLength = Number(res.headers.get('content-length')) || 0
    const total = contentLength || asset.size || 0
    state.total = total

    const stream = Readable.fromWeb(res.body as any)
    let received = 0
    let lastEmit = 0

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length

        const now = Date.now()
        if (now - lastEmit >= 200 || (total && received >= total)) {
          lastEmit = now
          state.received = received
          state.progress = total ? Math.min(100, (received / total) * 100) : 0
          broadcast()
        }

        callback(null, chunk)
      },
    })

    await pipeline(stream, counter, fs.createWriteStream(dest))

    state.received = received || total
    state.progress = 100
    state.downloadedPath = dest
    logger.info('update downloaded', dest)
    setPhase('downloaded')
  } catch (err) {
    try {
      await fs.promises.rm(dest, { force: true })
    } catch {
      // ignore
    }

    if (controller && controller.signal.aborted) {
      logger.info('update download cancelled')
      state.error = ''
      resetDownloadState()
      setPhase(state.hasUpdate ? 'available' : 'latest')
    } else {
      logger.error(
        'update download failed',
        err instanceof Error ? err.message : err,
      )
      state.error = toErrorMessage(err, t('updateDownloadErr'))
      setPhase('error')
    }
  } finally {
    controller = null
    downloading = false
  }

  return getState()
}

export function cancelDownload() {
  if (controller) {
    controller.abort()
  }
  return getState()
}

export async function installUpdate() {
  const file = state.downloadedPath

  if (!file) {
    return getState()
  }

  const err = await shell.openPath(file)
  if (err) {
    state.error = err
    setPhase('error')
  }

  return getState()
}

export function init() {
  handleEvent('checkUpdate', (silent?: boolean) =>
    checkUpdate({ silent: !!silent }),
  )
  handleEvent('getUpdateState', () => getState())
  handleEvent('downloadUpdate', () => downloadUpdate())
  handleEvent('cancelUpdateDownload', () => cancelDownload())
  handleEvent('installUpdate', () => installUpdate())
}

// 每次启动都在后台异步检查一次，失败不打扰用户
export function autoCheck(delay = 4000) {
  setTimeout(() => {
    // 用户已经手动检查过就不再重复请求
    if (state.checkedAt) return

    checkUpdate({ silent: true }).catch((err) => {
      logger.warn('auto check update failed', err)
    })
  }, delay)
}
