import * as base from '../../adb/base'
import { getDevicePlatform } from '../../adb/platform'
import {
  ILinuxLogLine,
  parseLinuxLog,
  pickLogSource,
  snapshotCommand,
} from '../../log/linux'
import dateFormat from 'licia/dateFormat'
import { resolveDeviceId } from '../lib/device'
import {
  filterLogcat,
  LOG_LEVELS,
  parseLogcat,
  summarizeLogcat,
} from '../lib/parse'
import { jsonResult, McpError } from '../lib/result'
import { detectShellError } from '../lib/shellCheck'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const MAX_FETCH = 5000

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

interface ILogQuery {
  deviceId: string
  lines: number
  level: string
  tag: string
  keyword: string
  pid?: number
  since?: string
}

function buildCommand(query: ILogQuery, timeoutFetch?: number) {
  const parts = ['logcat', '-d', '-v', 'threadtime']

  if (query.since) {
    // -T 支持 "MM-DD HH:MM:SS.mmm" 与 "YYYY-MM-DD HH:MM:SS.mmm"
    parts.push('-T', quote(query.since))
  } else {
    parts.push('-t', String(timeoutFetch || query.lines))
  }

  if (query.pid) {
    parts.push(`--pid=${query.pid}`)
  }

  // 级别过滤交给 logcat 自己做，避免先拉全量再丢弃
  if (query.level !== 'V') {
    parts.push(quote(`*:${query.level}`))
  }

  let command = parts.join(' ')
  // 标签/关键字在设备端先筛，回传量直接降到命中条数
  if (query.tag) {
    command += ` | grep -i -F ${quote(query.tag)}`
  }
  if (query.keyword) {
    command += ` | grep -i -F ${quote(query.keyword)}`
  }

  return command
}

// Linux 主板没有 logcat：用 journalctl/dmesg，转成同样的 entry 结构
function toMcpEntries(entries: ILinuxLogLine[]) {
  return entries.map((entry) => ({
    time: dateFormat(entry.date, 'mm-dd HH:MM:ss.l'),
    pid: entry.pid,
    tid: 0,
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
  }))
}

async function fetchLogs(query: ILogQuery, fetchLines?: number) {
  const platform = await getDevicePlatform(query.deviceId)
  if (platform.platform === 'linux') {
    const source = pickLogSource(platform)
    const command = snapshotCommand(source, fetchLines || query.lines)
    const raw = await base.shell(query.deviceId, command)
    let entries = toMcpEntries(parseLinuxLog(raw, source))
    if (query.pid) {
      entries = entries.filter((entry) => entry.pid === query.pid)
    }
    // journalctl/dmesg 没有 Android 的 tag 体系，过滤放主机侧
    return {
      raw,
      entries: filterLogcat(entries, {
        level: query.level,
        tag: query.tag,
        keyword: query.keyword,
      }),
      command,
    }
  }

  const command = buildCommand(query, fetchLines)
  const raw = await base.shell(query.deviceId, command)
  const entries = filterLogcat(parseLogcat(raw), {
    level: query.level,
    tag: '',
    keyword: '',
  })

  return { raw, entries, command }
}

function normalizeQuery(args: any, deviceId: string): ILogQuery {
  const lines = Math.min(
    Math.max(Math.floor(Number(args.lines) || 200), 1),
    2000
  )
  const level = String(args.level || 'V').toUpperCase()
  if (!(level in LOG_LEVELS)) {
    throw new McpError(
      'INVALID_ARGS',
      `level 必须是 V/D/I/W/E/F 之一，收到：${level}`
    )
  }

  return {
    deviceId,
    lines,
    level,
    tag: String(args.tag || '').trim(),
    keyword: String(args.keyword || '').trim(),
    pid:
      typeof args.pid === 'number' && args.pid > 0
        ? Math.floor(args.pid)
        : undefined,
    since: String(args.since || '').trim() || undefined,
  }
}

const logcat: McpTool = {
  name: 'aya_logcat',
  description:
    '读取设备日志缓冲区（logcat -d 快照）。支持级别/标签/关键字/pid/since 过滤，过滤在设备端完成，只回传命中的行；自动生成崩溃摘要（fatal/anr/进程/异常类）。推荐流程：aya_clear_logcat 清空 → 执行操作 → aya_logcat。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      lines: {
        type: 'number',
        description: '最多返回多少条（默认 200，上限 2000）',
      },
      level: {
        type: 'string',
        description: '最低日志级别：V/D/I/W/E/F，默认 V。排查崩溃用 E',
      },
      tag: {
        type: 'string',
        description: '标签子串过滤（不区分大小写），如 ActivityManager',
      },
      keyword: {
        type: 'string',
        description: '日志正文子串过滤（不区分大小写），如 Exception',
      },
      pid: { type: 'number', description: '只看指定进程的日志（--pid）' },
      since: {
        type: 'string',
        description:
          '起始时间（logcat -T），格式 "MM-DD HH:MM:SS.mmm"；省略则按 lines 取最近 N 行',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const query = normalizeQuery(args, deviceId)
    const filtered = !!(query.tag || query.keyword || query.since)

    // 无过滤时按需取行；有过滤时多取一些原始行，但传输已被设备端 grep 削减
    const fetchLines = filtered
      ? Math.min(Math.max(query.lines * 20, 500), MAX_FETCH)
      : query.lines

    const { raw, entries } = await fetchLogs(query, fetchLines)
    const sliced = entries.slice(-query.lines)
    const summary = summarizeLogcat(sliced)
    const errorHint = detectShellError(raw)

    return jsonResult({
      ok: true,
      deviceId,
      fetchedLines: fetchLines,
      matched: entries.length,
      returned: sliced.length,
      truncated: entries.length > query.lines,
      empty: entries.length === 0,
      summary,
      // 只有真的命中崩溃时才给 errorHint，避免返回无关噪声
      errorHint: summary.hint || errorHint || null,
      entries: sliced,
    })
  },
}

const clearLogcat: McpTool = {
  name: 'aya_clear_logcat',
  description:
    '清空设备日志缓冲区（logcat -c）。配合 aya_logcat 使用：先清空，再操作，最后只看到本次操作产生的日志。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const platform = await getDevicePlatform(deviceId)
    if (platform.platform === 'linux') {
      return jsonResult({
        ok: false,
        deviceId,
        errorHint:
          'Linux 设备没有 logcat 环形缓冲，无法清空；请看最近日志（aya_logcat 带 lines/keyword），或执行 aya_shell "journalctl --rotate" 轮转（需 root）',
      })
    }

    const output = await base.shell(deviceId, 'logcat -c')
    const errorHint = detectShellError(output)

    return jsonResult({
      ok: !errorHint,
      deviceId,
      errorHint: errorHint || null,
    })
  },
}

const logcatWait: McpTool = {
  name: 'aya_logcat_wait',
  description:
    '等待某条日志出现：内部按 interval 短轮询 logcat -d -t 200（设备端已过滤），命中立即返回，比「清空→操作→再查」少一次往返。超时返回本次抓到的最后若干条便于排查。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      tag: { type: 'string', description: '标签子串' },
      keyword: { type: 'string', description: '正文关键字子串' },
      level: {
        type: 'string',
        description: '最低级别，默认 V（排查异常建议 E）',
      },
      pid: { type: 'number', description: '只看指定进程' },
      timeout: {
        type: 'number',
        description: '最长等待毫秒数，默认 10000，上限 60000',
      },
      interval: {
        type: 'number',
        description: '轮询间隔毫秒数，默认 500',
      },
      lines: {
        type: 'number',
        description: '超时时返回多少条日志，默认 50',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 90000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const query = normalizeQuery(
      {
        ...args,
        lines: args.lines || 50,
      },
      deviceId
    )

    if (!query.tag && !query.keyword) {
      throw new McpError(
        'INVALID_ARGS',
        'aya_logcat_wait 至少需要 tag 或 keyword 之一作为命中条件'
      )
    }

    const timeout = Math.min(
      Math.max(Math.floor(Number(args.timeout) || 10000), 100),
      60000
    )
    const interval = Math.min(
      Math.max(Math.floor(Number(args.interval) || 500), 100),
      5000
    )
    const started = Date.now()
    let attempts = 0
    let last: any[] = []

    while (Date.now() - started < timeout) {
      attempts++
      const { entries } = await fetchLogs(query, 200)
      last = entries.slice(-query.lines)
      if (last.length) {
        return jsonResult({
          ok: true,
          deviceId,
          hit: true,
          attempts,
          waitedMs: Date.now() - started,
          summary: summarizeLogcat(last),
          entries: last,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    return jsonResult({
      ok: true,
      deviceId,
      hit: false,
      attempts,
      waitedMs: Date.now() - started,
      hint: '超时未命中；可放宽 keyword/tag、降低 level，或改用 aya_logcat 直接查看缓冲区',
      entries: last,
    })
  },
}

export default [logcat, clearLogcat, logcatWait]
