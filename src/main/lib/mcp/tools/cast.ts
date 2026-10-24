import { getScreencastStore } from '../../store'
import * as screencast from '../../../window/screencast'
import { getCurrentDeviceId, resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const DEFAULT_SETTINGS = { videoBitRate: 8000000, maxSize: 0 }

// 以 screencast 模块持有的窗口句柄为准：getWin 表在窗口销毁后可能残留，
// 用它判断会出现“窗口已关但 visible 仍为 true”
function isCastVisible() {
  return screencast.isShown()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 窗口创建与销毁都是异步的，轮询到目标状态再返回，避免返回过期的可见性
async function waitVisible(expected: boolean, timeout = 2500) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (isCastVisible() === expected) {
      return true
    }
    await sleep(100)
  }

  return isCastVisible() === expected
}

function readSettings(deviceId: string) {
  const settings = getScreencastStore().get('settings') || {}
  const current = settings[deviceId] || {}

  return {
    videoBitRate:
      typeof current.videoBitRate === 'number'
        ? current.videoBitRate
        : DEFAULT_SETTINGS.videoBitRate,
    maxSize:
      typeof current.maxSize === 'number'
        ? current.maxSize
        : DEFAULT_SETTINGS.maxSize,
  }
}

function normalizeBitRate(value: unknown) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num) || num < 100000 || num > 100000000) {
    throw new McpError(
      'INVALID_ARGS',
      `videoBitRate 需在 100000-100000000（bps）之间，收到：${String(value)}`
    )
  }

  return num
}

function normalizeMaxSize(value: unknown) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num) || num < 0 || num > 4096) {
    throw new McpError(
      'INVALID_ARGS',
      `maxSize 需在 0-4096 之间（0 表示原分辨率），收到：${String(value)}`
    )
  }

  return num
}

const castWindow: McpTool = {
  name: 'aya_cast_window',
  description:
    '控制 AYA 的投屏（scrcpy）窗口：open 打开、close 关闭、restart 重启（重启常用于让新设置生效）。只影响桌面窗口，不改变设备状态。可传 deviceId 指定投屏哪个设备（不传则跟随 AYA 当前选中设备，传了则窗口固定该设备）。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'close', 'restart'],
        description: 'open 打开投屏窗口，close 关闭，restart 关闭后重新打开',
      },
      deviceId: deviceIdProperty,
    },
    required: ['action'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const action = String(args.action || '').toLowerCase()
    if (['open', 'close', 'restart'].indexOf(action) < 0) {
      throw new McpError(
        'INVALID_ARGS',
        `action 只能是 open / close / restart，收到：${String(args.action)}`
      )
    }

    // close 不依赖设备：设备全掉线时也要能关掉窗口
    const deviceId =
      action === 'close' ? '' : await resolveDeviceId(args.deviceId)
    const pinned = typeof args.deviceId === 'string' && !!args.deviceId

    if (action === 'open') {
      screencast.showWin(deviceId || undefined)
    } else if (action === 'close') {
      screencast.closeWin()
    } else {
      screencast.closeWin()
      await sleep(300)
      screencast.showWin(deviceId || undefined)
    }

    // close 走 destroy，窗口对象销毁后句柄表可能残留，以操作结果为准
    const visible =
      action === 'close' ? false : await waitVisible(true, 6000)

    return jsonResult({
      ok: true,
      action,
      deviceId: deviceId || getCurrentDeviceId(),
      pinned,
      visible,
      hint:
        action === 'close'
          ? '投屏窗口已关闭'
          : pinned
            ? '投屏窗口已打开并固定到该设备；截图/点击请继续用 aya_screencap / aya_tap'
            : '投屏窗口在桌面弹出，截图/点击请继续用 aya_screencap / aya_tap',
    })
  },
}

const castSettings: McpTool = {
  name: 'aya_cast_settings',
  description:
    '读取或修改投屏画质参数：videoBitRate（码率，默认 8000000）、maxSize（最大边长，0 为原分辨率）。不传参数即只读取；修改后传 restart:true 立即重启投屏窗口生效。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      videoBitRate: { type: 'number', description: '码率 bps，100000-100000000' },
      maxSize: { type: 'number', description: '最大边长像素，0-4096，0 为原分辨率' },
      restart: {
        type: 'boolean',
        description: '修改后是否重启投屏窗口使设置生效',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const store = getScreencastStore()
    const settings = store.get('settings') || {}
    const current = readSettings(deviceId)

    const next = { ...current }
    if (args.videoBitRate !== undefined) {
      next.videoBitRate = normalizeBitRate(args.videoBitRate)
    }
    if (args.maxSize !== undefined) {
      next.maxSize = normalizeMaxSize(args.maxSize)
    }

    const changed =
      next.videoBitRate !== current.videoBitRate ||
      next.maxSize !== current.maxSize

    if (changed) {
      settings[deviceId] = next
      store.set('settings', settings)
    }

    let restarted = false
    if (changed && args.restart === true) {
      screencast.closeWin()
      await sleep(300)
      screencast.showWin()
      restarted = true
    }

    return jsonResult({
      ok: true,
      deviceId,
      changed,
      restarted,
      videoBitRate: next.videoBitRate,
      maxSize: next.maxSize,
      visible: restarted ? await waitVisible(true, 6000) : isCastVisible(),
      hint: changed && !restarted ? '设置已保存，重启投屏窗口后生效' : '',
    })
  },
}

export default [castWindow, castSettings]
