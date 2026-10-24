import { resolveDeviceId } from '../lib/device'
import {
  captureUi,
  performKey,
  performSwipe,
  performText,
  resolveSettle,
  resolveWithUi,
  verifyFocusedText,
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
  type: ['boolean', 'string'],
  description:
    '操作后是否立即抓取新界面。默认 "auto"：aya_tap 抓取（便于看到瞬时控件），滑动/按键/输入不抓取以省掉 0.3-1s；传 true 强制抓取，false 强制不抓取',
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

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

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

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

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
    '向当前焦点输入框输入 ASCII 文本。默认先清空输入框，并在输入前后自动切换到不带联想的输入法（Gboard/搜狗等会改写文本）；输入法切换期间界面可能短暂提示。传入 verify:true 会在输入后回读界面确认内容。非 ASCII 字符（中文等）请改用 aya_shell 配合 ADBKeyboard。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      text: { type: 'string', description: '要输入的 ASCII 文本' },
      clear: {
        type: 'boolean',
        description: '输入前是否清空输入框，默认 true',
      },
      ime: {
        type: 'string',
        enum: ['auto', 'keep'],
        description:
          'auto（默认）：当前是 Gboard/搜狗等会改写文本的输入法时，临时切到系统输入法并在输入后恢复；keep：不动输入法',
      },
      verify: {
        type: 'boolean',
        description: '输入后抓取界面回读焦点输入框内容，默认 false（会多花约 0.3-1s）',
      },
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
    const result = await performText(deviceId, value, resolveSettle(args, 200), {
      clear: args.clear !== false,
      ime: args.ime === 'keep' ? 'keep' : 'auto',
    })

    let verify: any = null
    if (args.verify === true) {
      verify = await verifyFocusedText(deviceId, value).catch((err) => ({
        matched: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

    return jsonResult({
      ok: true,
      deviceId,
      text: value,
      settledMs: result.settledMs,
      cleared: result.cleared,
      ime: result.ime,
      verify,
      ...extra,
    })
  },
}

export default [swipe, key, text]
