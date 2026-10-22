import { getTopPackage } from '../../adb/package'
import { resolveDeviceId } from '../lib/device'
import { jsonResult } from '../lib/result'
import { McpTool } from './types'

const currentApp: McpTool = {
  name: 'aya_current_app',
  description: '获取当前前台应用的包名与进程 pid。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const result = await getTopPackage(deviceId)

    return jsonResult({ ok: true, deviceId, package: result.name, pid: result.pid })
  },
}

export default [currentApp]
