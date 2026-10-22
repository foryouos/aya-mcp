import * as adb from '../../adb'
import * as base from '../../adb/base'
import { getCurrentDeviceId, listOnlineDevices, resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id（如 emulator-5554）。省略时使用 AYA 当前选中设备',
}

const listDevices: McpTool = {
  name: 'aya_list_devices',
  description:
    '列出所有已连接的 Android 设备及其状态，并标注 AYA 当前选中的设备。调用其他工具前先用它确认 deviceId。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  annotations: { readOnlyHint: true },
  handler: async () => {
    const devices = await adb.getDevices()
    const current = getCurrentDeviceId()

    return jsonResult({
      current: current || null,
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        androidVersion: device.androidVersion,
        sdkVersion: device.sdkVersion,
        selected: device.id === current,
      })),
    })
  },
}

const deviceInfo: McpTool = {
  name: 'aya_device_info',
  description:
    '获取设备概要信息：型号、品牌、Android 版本、屏幕分辨率与密度、内存、存储、CPU 核心数、续航等。',
  inputSchema: {
    type: 'object',
    properties: { deviceId: deviceIdProperty },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const overview = await adb.getOverview(deviceId)
    const performance = await adb
      .getPerformance(deviceId)
      .catch(() => null)

    return jsonResult({
      deviceId,
      overview,
      performance: performance
        ? {
            cpuLoads: performance.cpuLoads,
            cpuTemperature: performance.cpuTemperature,
            memUsed: performance.memUsed,
            memTotal: performance.memTotal,
            batteryLevel: performance.batteryLevel,
          }
        : null,
      online: (await listOnlineDevices()).some((item) => item.id === deviceId),
    })
  },
}

const setFontScale: McpTool = {
  name: 'aya_set_font_scale',
  description:
    '调整系统字体缩放（settings put system font_scale），用于验证大字体/小字体下的界面表现。写入后系统立即生效，部分应用需重启 Activity 才刷新。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      scale: {
        type: 'number',
        description: '缩放倍数，1.0 为默认，范围 0.5 - 2.0',
      },
    },
    required: ['scale'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const scale = Math.round(Number(args.scale) * 100) / 100

    if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) {
      throw new McpError(
        'INVALID_ARGS',
        `scale 需在 0.5 - 2.0 之间，收到：${String(args.scale)}`
      )
    }

    const previous = await base
      .shell(deviceId, 'settings get system font_scale')
      .then((value) => String(value).trim())
      .catch(() => '')

    await adb.setFontScale(deviceId, scale)
    const current = await base
      .shell(deviceId, 'settings get system font_scale')
      .then((value) => String(value).trim())
      .catch(() => '')

    return jsonResult({
      ok: true,
      deviceId,
      previous: previous === 'null' ? null : previous || null,
      scale: current === 'null' ? null : current || String(scale),
      hint:
        Number(current) === scale
          ? '已生效；若界面未变化，重启对应 Activity 后再看'
          : '命令已执行但读回值不一致，设备可能不支持该设置',
    })
  },
}

export default [listDevices, deviceInfo, setFontScale]
