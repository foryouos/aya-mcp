import { resolveDeviceId } from '../lib/device'
import {
  captureUi,
  performKey,
  performSwipe,
  performText,
  resolveSettle,
} from '../lib/action'
import { jsonResult } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const settleProperty = {
  type: 'number',
  description: '操作后等待界面稳定的毫秒数，默认 300',
}

const withUiProperty = {
  type: 'boolean',
  description:
    '操作后是否立即抓取新界面（默认 false；打开可省掉一次 aya_ui_dump，但会多花约 0.5-1s）',
}

const uiMaxNodesProperty = {
  type: 'number',
  description: 'withUi 回传的可交互节点上限，默认 60',
}

async function capture(deviceId: string, args: any) {
  try {
    return {
      ui: await captureUi(deviceId, { maxNodes: args.uiMaxNodes }),
      uiError: null as string | null,
    }
  } catch (err) {
    return {
      ui: null,
      uiError: err instanceof Error ? err.message : String(err),
    }
  }
}

const swipe: McpTool = {
  name: 'aya_swipe',
  description:
    '在屏幕上滑动，从 (x1,y1) 滑到 (x2,y2)。duration 为滑动时长（毫秒），默认 300。连续滑动时可开 withUi 观察结果。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      x1: { type: 'number', description: '起点 X' },
      y1: { type: 'number', description: '起点 Y' },
      x2: { type: 'number', description: '终点 X' },
      y2: { type: 'number', description: '终点 Y' },
      duration: { type: 'number', description: '滑动时长（毫秒），默认 300' },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['x1', 'y1', 'x2', 'y2'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const duration =
      typeof args.duration === 'number' && args.duration > 0
        ? args.duration
        : 300
    const settledMs = await performSwipe(
      deviceId,
      { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 },
      duration,
      resolveSettle(args, 300)
    )

    const extra = args.withUi === true ? await capture(deviceId, args) : {}

    return jsonResult({ ok: true, deviceId, duration, settledMs, ...extra })
  },
}

const key: McpTool = {
  name: 'aya_key',
  description:
    '发送按键事件。支持名称（back/home/enter/recent/volume_up/volume_down/power/menu/delete/tab/escape/search/dpad_*）或 Android keycode 数字。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      key: {
        type: ['string', 'number'],
        description: '按键名称或 keycode，例如 "back" 或 4',
      },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['key'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const { code, settledMs } = await performKey(
      deviceId,
      args.key,
      resolveSettle(args, 300)
    )

    const extra = args.withUi === true ? await capture(deviceId, args) : {}

    return jsonResult({
      ok: true,
      deviceId,
      key: args.key,
      keycode: code,
      settledMs,
      ...extra,
    })
  },
}

const text: McpTool = {
  name: 'aya_text',
  description:
    '向当前焦点输入框输入 ASCII 文本。非 ASCII 字符（中文等）请改用 aya_shell 配合输入法或 ADBKeyboard。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      text: { type: 'string', description: '要输入的 ASCII 文本' },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['text'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const value = String(args.text)
    const settledMs = await performText(
      deviceId,
      value,
      resolveSettle(args, 300)
    )

    const extra = args.withUi === true ? await capture(deviceId, args) : {}

    return jsonResult({ ok: true, deviceId, text: value, settledMs, ...extra })
  },
}

export default [swipe, key, text]
