import { getMainStore } from '../../store'
import * as adb from '../../adb'
import { McpError } from './result'
import { IDevice } from 'common/types'

function isOnline(device: IDevice) {
  return device.type === 'device' || device.type === 'emulator'
}

export async function listOnlineDevices(): Promise<IDevice[]> {
  const devices = await adb.getDevices()

  return devices.filter(isOnline)
}

export async function resolveDeviceId(requested?: string): Promise<string> {
  const devices = await listOnlineDevices()

  if (!devices.length) {
    throw new McpError('NO_DEVICE', '没有在线设备，请先在 AYA 中连接 Android 设备')
  }

  if (requested) {
    const found = devices.find((device) => device.id === requested)
    if (!found) {
      throw new McpError(
        'DEVICE_OFFLINE',
        `设备 ${requested} 不在线`,
        { devices: devices.map((device) => device.id) }
      )
    }
    return found.id
  }

  const current = getMainStore().get('device')
  if (current && current.id) {
    const found = devices.find((device) => device.id === current.id)
    if (found) {
      return found.id
    }
  }

  return devices[0].id
}

export function getCurrentDeviceId(): string {
  const current = getMainStore().get('device')

  return current && current.id ? current.id : ''
}
