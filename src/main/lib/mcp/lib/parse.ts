/**
 * 纯函数解析器：不依赖 adb/electron，便于单独测试与复用。
 */

export interface IPackageEntry {
  name: string
  system: boolean
  apkPath: string
}

const SYSTEM_PATH = /^\/(system|system_ext|product|vendor|odm|apex)\//

/**
 * 解析 `pm list packages -f` 输出。
 * 每行形如 `package:/data/app/xxx/base.apk=com.foo` 或 `package:com.foo`。
 */
export function parsePackageList(output: string): IPackageEntry[] {
  const ret: IPackageEntry[] = []
  const seen: { [name: string]: boolean } = {}

  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    if (!line || !line.startsWith('package:')) {
      return
    }

    const rest = line.slice('package:'.length)
    let name = rest
    let apkPath = ''
    const eq = rest.lastIndexOf('=')
    if (eq > 0) {
      apkPath = rest.slice(0, eq)
      name = rest.slice(eq + 1)
    }

    name = name.trim()
    if (!name || seen[name]) {
      return
    }
    seen[name] = true

    ret.push({
      name,
      apkPath,
      system: SYSTEM_PATH.test(apkPath),
    })
  })

  ret.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return ret
}

export interface IPackageDump {
  versionName: string
  versionCode: number
  minSdk: number
  targetSdk: number
  codePath: string
  dataDir: string
  firstInstallTime: string
  lastUpdateTime: string
  primaryCpuAbi: string
  flags: string[]
}

function matchOne(output: string, reg: RegExp): string {
  const match = output.match(reg)

  return match ? match[1].trim() : ''
}

/**
 * 从 `dumpsys package <pkg>` 中抽取少量稳定字段。
 * 不同 Android 版本的输出差异较大，因此全部字段都允许缺失（空值）。
 */
export function parseDumpsysPackage(output: string): IPackageDump {
  const versionLine = output.match(
    /versionCode=(\d+)\s+minSdk=(\d+)\s+targetSdk=(\d+)/
  )
  const versionCode = versionLine
    ? parseInt(versionLine[1], 10)
    : parseInt(matchOne(output, /versionCode=(\d+)/) || '0', 10)
  const minSdk = versionLine
    ? parseInt(versionLine[2], 10)
    : parseInt(matchOne(output, /\bminSdk=(\d+)/) || '0', 10)
  const targetSdk = versionLine
    ? parseInt(versionLine[3], 10)
    : parseInt(matchOne(output, /\btargetSdk=(\d+)/) || '0', 10)

  const flagsLine = matchOne(output, /flags=\[([^\]]*)\]/)

  return {
    versionName: matchOne(output, /versionName=(\S+)/),
    versionCode: isNaN(versionCode) ? 0 : versionCode,
    minSdk: isNaN(minSdk) ? 0 : minSdk,
    targetSdk: isNaN(targetSdk) ? 0 : targetSdk,
    codePath: matchOne(output, /codePath=(\S+)/),
    dataDir: matchOne(output, /dataDir=(\S+)/),
    firstInstallTime: matchOne(output, /firstInstallTime=(.+)/),
    lastUpdateTime: matchOne(output, /lastUpdateTime=(.+)/),
    primaryCpuAbi: matchOne(output, /primaryCpuAbi=(\S+)/),
    flags: flagsLine ? flagsLine.split(/\s+/).filter(Boolean) : [],
  }
}

export interface ILogEntry {
  time: string
  pid: number
  tid: number
  level: string
  tag: string
  message: string
}

export const LOG_LEVELS: { [level: string]: number } = {
  V: 0,
  D: 1,
  I: 2,
  W: 3,
  E: 4,
  F: 5,
  S: 6,
}

const LOGCAT_LINE =
  /^(\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s?(.*)$/

/**
 * 解析 `logcat -v threadtime` 输出。续行（堆栈等）会追加到上一条 message。
 */
export function parseLogcat(output: string): ILogEntry[] {
  const ret: ILogEntry[] = []
  let current: ILogEntry | null = null

  output.split(/\r?\n/).forEach((line) => {
    if (!line.trim() || line.startsWith('---------')) {
      return
    }

    const match = line.match(LOGCAT_LINE)
    if (match) {
      current = {
        time: match[1],
        pid: parseInt(match[2], 10),
        tid: parseInt(match[3], 10),
        level: match[4],
        tag: match[5],
        message: match[6],
      }
      ret.push(current)
      return
    }

    if (current && /^\s/.test(line)) {
      current.message += '\n' + line
    }
  })

  return ret
}

export function filterLogcat(
  entries: ILogEntry[],
  options: { level?: string; tag?: string; keyword?: string } = {}
): ILogEntry[] {
  const minLevel = LOG_LEVELS[(options.level || 'V').toUpperCase()] ?? 0
  const tag = (options.tag || '').toLowerCase()
  const keyword = (options.keyword || '').toLowerCase()

  return entries.filter((entry) => {
    if ((LOG_LEVELS[entry.level] ?? 0) < minLevel) {
      return false
    }
    if (tag && !entry.tag.toLowerCase().includes(tag)) {
      return false
    }
    if (keyword && !entry.message.toLowerCase().includes(keyword)) {
      return false
    }

    return true
  })
}
