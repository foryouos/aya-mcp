import { app, net } from 'electron'
import log from 'share/common/log'
import * as window from './window'

const logger = log('updater')

// 更新发布在本分支的 GitHub Releases 上。
// 这里直接读 GitHub API，而不使用 electron-updater：
// electron-updater 的 GitHub provider 要求 Release 里带 latest.yml，
// 缺失时会直接抛错，导致“检查版本失败”。
const RELEASES_API =
  'https://api.github.com/repos/foryouos/aya-mcp/releases?per_page=30'

interface IGithubRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

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

async function fetchLatestVersion() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `AYA/${app.getVersion()}`,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}`)
    }

    const releases = (await res.json()) as IGithubRelease[]

    if (!Array.isArray(releases)) {
      throw new Error('invalid response')
    }

    let latest: number[] | null = null

    for (const release of releases) {
      if (release.draft || release.prerelease || !release.tag_name) continue

      const version = parseVersion(release.tag_name)
      if (!version) continue

      if (!latest || compareVersion(version, latest) > 0) {
        latest = version
      }
    }

    return latest
  } finally {
    clearTimeout(timer)
  }
}

export async function checkUpdate() {
  try {
    const current = parseVersion(app.getVersion())

    if (!current) {
      throw new Error(`invalid current version ${app.getVersion()}`)
    }

    const latest = await fetchLatestVersion()

    if (latest && compareVersion(latest, current) > 0) {
      logger.info('update available', latest.join('.'))
      window.sendTo('main', 'updateAvailable')
    } else {
      logger.info('already latest', current.join('.'))
      window.sendTo('main', 'updateNotAvailable')
    }
  } catch (err) {
    logger.error(
      'check update failed',
      err instanceof Error ? err.message : err
    )
    window.sendTo('main', 'updateError')
  }
}
