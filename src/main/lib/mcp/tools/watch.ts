import { resolveDeviceId } from '../lib/device'
import { watchUi } from '../../adb/server'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return fallback
  }

  return Math.min(Math.max(Math.floor(num), min), max)
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

const watch: McpTool = {
  name: 'aya_ui_watch',
  description:
    '订阅界面变化事件（窗口切换 / 内容变化 / 页面切换 / 滚动），命中条件即返回事件摘要，超时返回 matched:false。用于「等界面自己动起来」「等某个应用/页面出现」「等列表滚起来」这类没有固定控件可等的场景：只观察事件、不抓整棵 UI 树，比反复 aya_ui_dump 省掉大量 dump。事件在设备端按 80ms 窗口合并，动画/滚动风暴不会刷屏。命中后通常紧接着 aya_ui_dump 拿快照再操作。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
      package: {
        type: 'string',
        description: '只匹配该包名（子串）的事件，例如 com.android.settings',
      },
      textContains: {
        type: 'string',
        description: '只匹配事件携带文本中包含该关键字的事件',
      },
      types: {
        type: 'array',
        items: { type: 'string', enum: ['state', 'content', 'windows', 'scroll'] },
        description:
          '只匹配这些事件类型：state=窗口/页面切换，content=内容变化，windows=窗口增删，scroll=滚动。默认全部',
      },
      settleMs: {
        type: 'number',
        description: '命中后再多收集多少毫秒事件（判断界面是否真正稳定），默认 0，上限 3000',
      },
      timeout: {
        type: 'number',
        description: '最长等待毫秒数，默认 5000，上限 15000',
      },
      maxEvents: {
        type: 'number',
        description: '返回的事件摘要条数上限，默认 20，上限 50',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const timeout = clamp(args.timeout, 100, 15000, 5000)
    const settleMs = clamp(args.settleMs, 0, 3000, 0)
    const maxEvents = clamp(args.maxEvents, 1, 50, 20)
    const started = Date.now()

    let result
    try {
      result = await watchUi(
        deviceId,
        {
          timeoutMs: timeout,
          settleMs,
          maxEvents,
          package: args.package ? String(args.package) : '',
          textContains: args.textContains ? String(args.textContains) : '',
          types: Array.isArray(args.types) ? args.types : [],
        },
        timeout
      )
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `界面事件通道不可用：${errorText(err)}。可改用 aya_wait_for 的轮询模式`
      )
    }

    const events = (result.events || []).slice(0, maxEvents)
    const matched = result.matched === true

    return jsonResult({
      ok: true,
      deviceId,
      matched,
      waitedMs: result.waitedMs || Date.now() - started,
      timeoutMs: timeout,
      settleMs,
      eventTotal: result.eventTotal || 0,
      matchedEvent: result.matchedEvent || null,
      events,
      hint: matched
        ? '事件已命中；需要节点坐标时接着调 aya_ui_dump（可传 clickableOnly/visibleOnly）'
        : '等待期内界面没有任何符合条件的事件：确认应用是否真的在变化，或放宽 types/package 条件',
    })
  },
}

export default [watch]
