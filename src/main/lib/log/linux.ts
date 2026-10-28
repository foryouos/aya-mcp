import { IDevicePlatform } from '../adb/platform'

// Linux 工控主板没有 logcat：优先 journalctl（systemd 发行版：Debian/Ubuntu），
// 其次 dmesg（Buildroot/Yocto 常见，只有内核日志）
export type LinuxLogSource = 'journalctl' | 'dmesg'

export interface ILinuxLogLine {
  date: Date
  pid: number
  // 与 Android logcat 对齐的级别字母，面板/MCP 不用区分平台
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F'
  tag: string
  message: string
  // 去重标识：journalctl 用 __CURSOR，dmesg 用方括号里的时间戳
  cursor?: string
}

// syslog prio(0=emerg ... 7=debug) -> Android 级别
const SYSLOG_LEVEL: Record<number, ILinuxLogLine['level']> = {
  0: 'F',
  1: 'F',
  2: 'F',
  3: 'E',
  4: 'W',
  5: 'I',
  6: 'I',
  7: 'D',
}

export function pickLogSource(platform: IDevicePlatform): LinuxLogSource {
  return platform.caps.journalctl ? 'journalctl' : 'dmesg'
}

export function snapshotCommand(source: LinuxLogSource, lines: number) {
  const count = Math.max(Math.floor(lines) || 200, 1)
  if (source === 'journalctl') {
    // -o json 一次拿到时间/优先级/pid/tag/message，避免解析 short-iso 文本
    return `journalctl -o json --no-pager -n ${count} 2>/dev/null`
  }

  return `dmesg 2>/dev/null | tail -n ${count}`
}

export function followCommand(source: LinuxLogSource) {
  if (source === 'journalctl') {
    return 'journalctl -o json -f -n 0 --no-pager 2>/dev/null'
  }

  return 'dmesg -w 2>/dev/null'
}

function toMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  // journalctl 遇到非 UTF-8 内容会把 MESSAGE 输出成字节数组
  if (Array.isArray(value)) {
    return Buffer.from(value as number[]).toString('utf8')
  }

  return value === undefined || value === null ? '' : String(value)
}

function parseJournalLine(line: string): ILinuxLogLine | null {
  if (!line.startsWith('{')) {
    return null
  }
  let obj: any
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }

  // __REALTIME_TIMESTAMP 是微秒
  const micro = Number(obj.__REALTIME_TIMESTAMP)
  const date = Number.isFinite(micro) && micro > 0 ? new Date(micro / 1000) : new Date()
  const prio = Number(obj.PRIORITY)
  const tag =
    obj.SYSLOG_IDENTIFIER || obj._COMM || obj._SYSTEMD_UNIT || 'journal'

  return {
    date,
    pid: Number(obj._PID || obj.SYSLOG_PID || 0) || 0,
    level: SYSLOG_LEVEL[Number.isFinite(prio) ? prio : 6] || 'I',
    tag: String(tag),
    message: toMessage(obj.MESSAGE),
    cursor: typeof obj.__CURSOR === 'string' ? obj.__CURSOR : undefined,
  }
}

// dmesg 两种格式：[   12.345678] msg 与 [2026-10-28T17:44:18,123456+08:00] msg
const DMESG_WITH_STAMP = /^\[([^\]]+)\]\s?(.*)$/

function parseDmesgLine(line: string): ILinuxLogLine | null {
  const match = line.match(DMESG_WITH_STAMP)
  if (!match) {
    return null
  }

  const stamp = match[1].trim()
  const text = match[2]
  let date = new Date()
  // ISO 时间戳（dmesg -T / --time-format=iso）才可信，相对秒数只能按当前时间算
  if (/^\d{4}-\d{2}-\d{2}T/.test(stamp)) {
    const parsed = new Date(stamp.replace(',', '.'))
    if (!isNaN(parsed.getTime())) {
      date = parsed
    }
  }

  return {
    date,
    pid: 0,
    // dmesg 里的 error/failed 之类按 E 处理，其余按 I
    level: /\b(error|failed|panic|oops|BUG:)/i.test(text) ? 'E' : 'I',
    tag: 'kernel',
    message: text,
    cursor: stamp,
  }
}

export function parseLinuxLog(output: string, source: LinuxLogSource) {
  const ret: ILinuxLogLine[] = []

  output.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      return
    }
    const entry =
      source === 'journalctl' ? parseJournalLine(line) : parseDmesgLine(line)
    if (entry) {
      ret.push(entry)
    }
  })

  return ret
}
