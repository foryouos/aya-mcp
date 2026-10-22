import * as adb from '../../adb'
import * as base from '../../adb/base'
import { resolveDeviceId } from '../lib/device'
import { withDeviceQueue } from '../lib/dump'
import { afterInput } from '../lib/action'
import { assertShellOk } from '../lib/shellCheck'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const KEY_CODES: { [name: string]: number } = {
  back: 4,
  home: 3,
  enter: 66,
  menu: 82,
  recent: 187,
  app_switch: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  delete: 67,
  tab: 61,
  escape: 111,
  search: 84,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
}

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const settleProperty = {
  type: 'number',
  description: '操作后等待界面稳定的毫秒数，默认 300',
}

const swipe: McpTool = {
  name: 'aya_swipe',
  description:
    '在屏幕上滑动，从 (x1,y1) 滑到 (x2,y2)。duration 为滑动时长（毫秒），默认 300。',
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

    const output = await withDeviceQueue(deviceId, () =>
      adb.inputSwipe(deviceId, args.x1, args.y1, args.x2, args.y2, duration)
    )
    assertShellOk(output, 'aya_swipe')
    const settledMs = await afterInput(
      deviceId,
      typeof args.settle === 'number' ? args.settle : 300
    )

    return jsonResult({ ok: true, deviceId, duration, settledMs })
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
    },
    required: ['key'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    let code = 0

    if (typeof args.key === 'number') {
      code = Math.round(args.key)
    } else {
      code = KEY_CODES[String(args.key).toLowerCase()] || 0
    }

    if (!code) {
      throw new McpError(
        'INVALID_ARGS',
        `未知按键 ${String(args.key)}，可用：${Object.keys(KEY_CODES).join(', ')}`
      )
    }

    await withDeviceQueue(deviceId, () => adb.inputKey(deviceId, code))
    const settledMs = await afterInput(
      deviceId,
      typeof args.settle === 'number' ? args.settle : 300
    )

    return jsonResult({ ok: true, deviceId, key: args.key, keycode: code, settledMs })
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
    },
    required: ['text'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const value = String(args.text)

    if (!/^[\x20-\x7E]+$/.test(value)) {
      throw new McpError(
        'INVALID_ARGS',
        'aya_text 仅支持可打印 ASCII 字符；中文等非 ASCII 文本请用 aya_shell 配合设备输入法'
      )
    }

    const escaped = value.replace(/'/g, `'\\''`).replace(/ /g, '%s')
    const output = await withDeviceQueue(deviceId, () =>
      base.shell(deviceId, `input text '${escaped}'`)
    )
    assertShellOk(output, 'aya_text')
    const settledMs = await afterInput(
      deviceId,
      typeof args.settle === 'number' ? args.settle : 300
    )

    return jsonResult({ ok: true, deviceId, text: value, settledMs })
  },
}

export default [swipe, key, text]
