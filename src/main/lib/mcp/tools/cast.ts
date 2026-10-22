import { getWin } from 'share/main/lib/window'
import { getScreencastStore } from '../../store'
import * as screencast from '../../../window/screencast'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const DEFAULT_SETTINGS = { videoBitRate: 8000000, maxSize: 0 }

function isCastVisible() {
  const win = getWin('screencast')

  return !!(win && win.isVisible())
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    '控制 AYA 的投屏（scrcpy）窗口：open 打开、close 关闭、restart 重启（重启常用于让新设置生效）。只影响桌面窗口，不改变设备状态。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'close', 'restart'],
        description: 'open 打开投屏窗口，close 关闭，restart 关闭后重新打开',
      },
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

    if (action === 'open') {
      screencast.showWin()
    } else if (action === 'close') {
      screencast.closeWin()
    } else {
      screencast.closeWin()
      await sleep(300)
      screencast.showWin()
    }

    // 窗口创建/销毁是异步的，稍等再读可见性
    await sleep(200)

    return jsonResult({
      ok: true,
      action,
      visible: isCastVisible(),
      hint:
        action === 'open' || action === 'restart'
          ? '投屏窗口在桌面弹出，截图/点击请继续用 aya_screencap / aya_tap'
          : '投屏窗口已关闭',
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
      await sleep(200)
    }

    return jsonResult({
      ok: true,
      deviceId,
      changed,
      restarted,
      videoBitRate: next.videoBitRate,
      maxSize: next.maxSize,
      visible: isCastVisible(),
      hint: changed && !restarted ? '设置已保存，重启投屏窗口后生效' : '',
    })
  },
}

export default [castWindow, castSettings]
