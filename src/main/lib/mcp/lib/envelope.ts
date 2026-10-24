// 结果协议 v2：在协议层统一给所有工具的返回补上 timing / cost / retryable /
// snapshot / suggestedNextCall，避免每个工具各写一份、也避免 AI 反复试探。
// 只在 JSON 文本结果上注入，图片结果原样返回。

import { IToolResult, McpErrorCode, ToolContent } from './result'
import { getSnapshot, SNAPSHOT_TTL_MS } from './snapshot'

export type CostLevel = 'low' | 'medium' | 'high'

export interface ITiming {
  totalMs: number
  dumpMs: number
  parseMs: number
  actionMs: number
  captureMs: number
  otherMs: number
}

export interface ISnapshotRef {
  id: string
  expiresAt: number | null
  stale: boolean
}

export interface ISuggestedCall {
  tool: string
  args: Record<string, unknown>
  reason: string
}

// 瞬时失败重试有意义；参数/权限类错误重试不会变好，直接让调用方换参数或找人
const RETRYABLE: { [code in McpErrorCode]: boolean } = {
  NO_DEVICE: false,
  DEVICE_OFFLINE: true,
  DUMP_FAILED: true,
  STALE_SNAPSHOT: true,
  NO_MATCH: false,
  AMBIGUOUS_MATCH: false,
  WRITE_DISABLED: false,
  NOT_FOUND: false,
  PERMISSION_DENIED: false,
  TIMEOUT: true,
  PORT_IN_USE: true,
  INVALID_ARGS: false,
  INTERNAL: true,
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value)
  )
}

// 工具返回里 dump/parse 的时间既有顶层（wait_for）也有放在 ui 里（tap/key/batch）的
function readMs(data: Record<string, any>, key: string) {
  const direct = num(data[key])
  if (direct) {
    return direct
  }

  return isPlainObject(data.ui) ? num(data.ui[key]) : 0
}

function buildTiming(data: Record<string, any>, totalMs: number): ITiming {
  const dumpMs = readMs(data, 'dumpMs')
  const parseMs = readMs(data, 'parseMs')
  const captureMs = readMs(data, 'capturedMs')
  const actionMs = readMs(data, 'settledMs') || readMs(data, 'duration')
  // capturedMs 已经把 dump + parse 包含在内，取较大值避免重复计算
  const captureTotal = Math.max(captureMs, dumpMs + parseMs)
  const otherMs = Math.max(0, totalMs - captureTotal - actionMs)

  return { totalMs, dumpMs, parseMs, actionMs, captureMs, otherMs }
}

function levelOf(timing: ITiming): CostLevel {
  if (timing.totalMs >= 2500 || timing.dumpMs >= 1500) {
    return 'high'
  }
  if (timing.totalMs >= 800) {
    return 'medium'
  }

  return 'low'
}

function readSnapshot(data: Record<string, any>): ISnapshotRef | null {
  const candidates: any[] = [data, isPlainObject(data.error) ? data.error.detail : null]

  for (const item of candidates) {
    if (!isPlainObject(item) || typeof item.snapshotId !== 'string' || !item.snapshotId) {
      continue
    }

    const id = item.snapshotId
    const expiresAt = num(item.expiresAt)
    const deviceId =
      typeof item.deviceId === 'string' ? item.deviceId : data.deviceId
    if (expiresAt || typeof deviceId !== 'string') {
      return { id, expiresAt: expiresAt || null, stale: item.stale === true }
    }

    // 错误分支只带 snapshotId/deviceId：从当前快照补齐过期时间与失效状态
    const live = getSnapshot(deviceId)
    if (live && live.id === id) {
      return {
        id,
        expiresAt: live.createdAt + SNAPSHOT_TTL_MS,
        stale: live.stale,
      }
    }

    return { id, expiresAt: null, stale: item.stale === true }
  }

  return null
}

function suggest(code: string, data: Record<string, any>): ISuggestedCall | null {
  switch (code) {
    case 'NO_MATCH':
      return {
        tool: 'aya_ui_dump',
        args: { clickableOnly: true },
        reason: '当前界面没匹配到控件：先看可点击节点，再用 text/id/desc 定位',
      }
    case 'AMBIGUOUS_MATCH':
      return {
        tool: 'aya_ui_dump',
        args: { clickableOnly: true },
        reason: '匹配到多个控件：先 dump 确认，再用 nodeIndex + snapshotId 精确点击',
      }
    case 'STALE_SNAPSHOT':
      return {
        tool: 'aya_ui_dump',
        args: {},
        reason: '快照已过期：重新 dump 后使用新的 snapshotId',
      }
    case 'DUMP_FAILED':
    case 'TIMEOUT':
      return {
        tool: 'aya_ui_dump',
        args: {},
        reason: '界面未就绪或抓取超时：重试一次，仍失败则用 aya_screencap 确认屏幕状态',
      }
    case 'NO_DEVICE':
    case 'DEVICE_OFFLINE':
      return {
        tool: 'aya_list_devices',
        args: {},
        reason: '设备不在线：先确认连接状态与选中的设备',
      }
    case 'PORT_IN_USE':
      return {
        tool: 'aya_list_ports',
        args: {},
        reason: '端口被占用：换一个端口或先释放占用',
      }
    default:
      return null
  }
}

function enrich(
  data: Record<string, any>,
  totalMs: number
): Record<string, any> {
  const timing = buildTiming(data, totalMs)
  const ok = data.ok !== false
  const code = ok
    ? ''
    : String((isPlainObject(data.error) && data.error.code) || 'INTERNAL')
  const snapshot = readSnapshot(data)

  const next: Record<string, any> = {
    ...data,
    timing,
    cost: levelOf(timing),
    retryable: ok ? false : RETRYABLE[code as McpErrorCode] !== false,
  }

  if (snapshot) {
    next.snapshot = snapshot
  }
  if (!ok) {
    const suggestion = suggest(code, data)
    if (suggestion) {
      next.suggestedNextCall = suggestion
    }
  }

  return next
}

function parseText(text: string): Record<string, any> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function decorateResult(
  result: IToolResult,
  totalMs: number
): IToolResult {
  if (!result || !Array.isArray(result.content) || !result.content.length) {
    return result
  }

  let decorated = false
  const content: ToolContent[] = result.content.map((item) => {
    if (item.type !== 'text') {
      return item
    }

    const data = parseText(item.text)
    if (!data) {
      return item
    }

    decorated = true

    return {
      type: 'text' as const,
      text: JSON.stringify(enrich(data, totalMs), null, 2),
    }
  })

  return decorated ? { ...result, content } : result
}
