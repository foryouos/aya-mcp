import * as adb from '../../adb'
import { getCurrentDeviceId, listOnlineDevices, resolveDeviceId } from '../lib/device'
import { jsonResult } from '../lib/result'
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

export default [listDevices, deviceInfo]
