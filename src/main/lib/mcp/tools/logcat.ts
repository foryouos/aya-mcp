import * as base from '../../adb/base'
import { resolveDeviceId } from '../lib/device'
import { filterLogcat, LOG_LEVELS, parseLogcat } from '../lib/parse'
import { jsonResult, McpError } from '../lib/result'
import { detectShellError } from '../lib/shellCheck'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const MAX_FETCH = 5000

const logcat: McpTool = {
  name: 'aya_logcat',
  description:
    '读取设备日志缓冲区（logcat -d 快照），支持按级别/标签/关键字过滤，返回结构化条目。推荐流程：aya_clear_logcat 清空 → 执行操作 → aya_logcat 查看本次产生的日志（崩溃/异常一目了然）。',
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
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
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

    const tag = String(args.tag || '').trim()
    const keyword = String(args.keyword || '').trim()
    const filtered = !!tag || !!keyword || level !== 'V'

    // 有过滤条件时多抓一些原始日志，避免过滤后所剩无几
    const fetchLines = filtered
      ? Math.min(Math.max(lines * 20, 500), MAX_FETCH)
      : lines

    const raw = await base.shell(
      deviceId,
      `logcat -d -v threadtime -t ${fetchLines}`
    )

    const entries = filterLogcat(parseLogcat(raw), { level, tag, keyword })
    const sliced = entries.slice(-lines)
    const errorHint = detectShellError(raw)

    return jsonResult({
      ok: true,
      deviceId,
      fetchedLines: fetchLines,
      matched: entries.length,
      returned: sliced.length,
      truncated: entries.length > lines,
      empty: entries.length === 0,
      errorHint: errorHint || null,
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
    const output = await base.shell(deviceId, 'logcat -c')
    const errorHint = detectShellError(output)

    return jsonResult({
      ok: !errorHint,
      deviceId,
      errorHint: errorHint || null,
    })
  },
}

export default [logcat, clearLogcat]
