import { getScreencastStore } from '../../store'
import * as screencast from '../../../window/screencast'
import {
  listOnlineDevices,
  resolveDeviceId,
} from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

// 与投屏窗口内的上限保持一致：H.264 硬解器实例数有限
const MAX_CAST_DEVICES = 6

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

function currentLayout() {
  const layout = getScreencastStore().get('layout')

  return layout === 'spotlight' ? 'spotlight' : 'grid'
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

/** 校验 deviceIds 里的每台设备都在线，去重并保持顺序 */
async function resolveDeviceIds(requested: unknown): Promise<string[]> {
  if (!Array.isArray(requested) || !requested.length) {
    return []
  }

  const devices = await listOnlineDevices()
  if (!devices.length) {
    throw new McpError('NO_DEVICE', '没有在线设备，请先在 AYA 中连接 Android 设备')
  }

  const found: string[] = []
  const missing: string[] = []
  for (let i = 0, len = requested.length; i < len; i++) {
    const id = String(requested[i])
    if (found.indexOf(id) >= 0) {
      continue
    }
    if (devices.some((device) => device.id === id)) {
      found.push(id)
    } else {
      missing.push(id)
    }
  }

  if (missing.length) {
    throw new McpError(
      'DEVICE_OFFLINE',
      `设备 ${missing.join(', ')} 不在线`,
      { devices: devices.map((device) => device.id) }
    )
  }

  if (found.length > MAX_CAST_DEVICES) {
    throw new McpError(
      'INVALID_ARGS',
      `最多同时投屏 ${MAX_CAST_DEVICES} 台设备，收到 ${found.length} 台`
    )
  }

  return found
}

const castWindow: McpTool = {
  name: 'aya_cast_window',
  description:
    '控制 AYA 的投屏（scrcpy）窗口。一个窗口内可以同时显示多台设备（最多 6 台），支持等分网格与聚焦放大两种布局。' +
    'action：open 打开、close 关闭、restart 重启、add 追加一台、remove 移除一台、' +
    'focus 放大某一路（focusDeviceId 传空字符串取消）、layout 切换布局。' +
    '只影响桌面窗口，不改变设备状态。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'close', 'restart', 'add', 'remove', 'focus', 'layout'],
        description:
          'open 打开投屏窗口，close 关闭，restart 重启，add 追加设备，remove 移除设备，focus 聚焦放大某一路，layout 切换布局',
      },
      deviceId: deviceIdProperty,
      deviceIds: {
        type: 'array',
        items: { type: 'string' },
        description: `open / restart 时要同时投屏的设备 id 列表，最多 ${MAX_CAST_DEVICES} 台。省略时使用 deviceId 或 AYA 当前选中设备`,
      },
      focusDeviceId: {
        type: 'string',
        description: 'focus 动作的目标设备 id；传空字符串表示取消聚焦，回到等分网格',
      },
      layout: {
        type: 'string',
        enum: ['grid', 'spotlight'],
        description: 'layout 动作的目标布局：grid 等分网格，spotlight 聚焦放大',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const action = String(args.action || '').toLowerCase()
    if (
      ['open', 'close', 'restart', 'add', 'remove', 'focus', 'layout'].indexOf(
        action
      ) < 0
    ) {
      throw new McpError(
        'INVALID_ARGS',
        `action 只能是 open / close / restart / add / remove / focus / layout，收到：${String(args.action)}`
      )
    }

    // close 不依赖设备：设备全掉线时也要能关掉窗口
    if (action === 'close') {
      screencast.closeWin()
      return jsonResult({
        ok: true,
        action,
        deviceIds: [],
        visible: false,
        hint: '投屏窗口已关闭',
      })
    }

    if (action === 'focus') {
      if (!isCastVisible()) {
        throw new McpError('NOT_SUPPORTED', '投屏窗口未打开，请先执行 action=open')
      }
      const focusDeviceId =
        typeof args.focusDeviceId === 'string' ? args.focusDeviceId : ''
      screencast.focusDevice(focusDeviceId)
      return jsonResult({
        ok: true,
        action,
        focusDeviceId,
        layout: focusDeviceId ? 'spotlight' : 'grid',
        deviceIds: screencast.getDeviceIds(),
        visible: isCastVisible(),
      })
    }

    if (action === 'layout') {
      const layout = String(args.layout || '')
      if (layout !== 'grid' && layout !== 'spotlight') {
        throw new McpError(
          'INVALID_ARGS',
          `layout 只能是 grid / spotlight，收到：${String(args.layout)}`
        )
      }
      if (!isCastVisible()) {
        throw new McpError('NOT_SUPPORTED', '投屏窗口未打开，请先执行 action=open')
      }
      screencast.applyLayout(layout)
      return jsonResult({
        ok: true,
        action,
        layout,
        deviceIds: screencast.getDeviceIds(),
        visible: isCastVisible(),
      })
    }

    let deviceIds: string[] = []

    if (action === 'add') {
      const deviceId = await resolveDeviceId(args.deviceId)
      const current = screencast.getDeviceIds()
      if (current.indexOf(deviceId) >= 0) {
        deviceIds = current
      } else if (current.length >= MAX_CAST_DEVICES) {
        throw new McpError(
          'INVALID_ARGS',
          `最多同时投屏 ${MAX_CAST_DEVICES} 台设备，请先移除一台`
        )
      } else {
        deviceIds = current.concat([deviceId])
      }
    } else if (action === 'remove') {
      const deviceId = await resolveDeviceId(args.deviceId)
      deviceIds = screencast.getDeviceIds().filter((id) => id !== deviceId)
      if (!deviceIds.length) {
        screencast.closeWin()
        return jsonResult({
          ok: true,
          action,
          deviceId,
          deviceIds: [],
          visible: false,
          hint: '最后一台设备已移除，投屏窗口已关闭',
        })
      }
    } else {
      // open / restart
      const requested = await resolveDeviceIds(args.deviceIds)
      if (requested.length) {
        deviceIds = requested
      } else if (typeof args.deviceId === 'string' && args.deviceId) {
        deviceIds = [await resolveDeviceId(args.deviceId)]
      } else if (action === 'restart') {
        // 重启时保留当前设备列表，否则会把多设备 pin 丢掉
        deviceIds = screencast.getDeviceIds()
      }
    }

    const pinned = deviceIds.length > 0

    if (action === 'open') {
      screencast.showWin(deviceIds.length ? deviceIds : undefined)
    } else if (action === 'restart') {
      screencast.closeWin()
      await sleep(300)
      screencast.showWin(deviceIds.length ? deviceIds : undefined)
    } else {
      // add / remove 复用"整体同步"路径：窗口已存在时直接推送新列表
      screencast.showWin(deviceIds)
    }

    const visible = await waitVisible(true, 6000)

    return jsonResult({
      ok: true,
      action,
      deviceIds: deviceIds.length ? deviceIds : screencast.getDeviceIds(),
      pinned,
      visible,
      layout: currentLayout(),
      hint:
        action === 'add'
          ? '已追加设备，双击画面或调用 action=focus 可放大某一路'
          : pinned
            ? '投屏窗口已打开并固定到该设备列表；截图/点击请继续用 aya_screencap / aya_tap，并显式传 deviceId'
            : '投屏窗口在桌面弹出，跟随 AYA 当前选中设备',
    })
  },
}

const castSettings: McpTool = {
  name: 'aya_cast_settings',
  description:
    '读取或修改投屏画质参数：videoBitRate（码率，默认 8000000）、maxSize（最大边长，0 为原分辨率）。' +
    '多设备投屏（3 路及以上）时会自动降档到 maxSize 1024 / maxFps 30 以保证实时性。' +
    '不传参数即只读取；修改后传 restart:true 立即重启投屏窗口生效（保留当前设备列表）。',
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
  timeout: 60000,
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
      const deviceIds = screencast.getDeviceIds()
      screencast.closeWin()
      await sleep(300)
      // 保留多设备列表，避免重启后只剩一台
      screencast.showWin(deviceIds.length ? deviceIds : deviceId)
      restarted = true
    }

    return jsonResult({
      ok: true,
      deviceId,
      changed,
      restarted,
      deviceIds: screencast.getDeviceIds(),
      videoBitRate: next.videoBitRate,
      maxSize: next.maxSize,
      visible: restarted ? await waitVisible(true, 6000) : isCastVisible(),
      hint: changed && !restarted ? '设置已保存，重启投屏窗口后生效' : '',
    })
  },
}

export default [castWindow, castSettings]
