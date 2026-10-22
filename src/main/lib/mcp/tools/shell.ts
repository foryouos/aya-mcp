import * as base from '../../adb/base'
import { resolveDeviceId } from '../lib/device'
import { afterInput } from '../lib/action'
import { detectShellError } from '../lib/shellCheck'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const MAX_OUTPUT = 20000

const shell: McpTool = {
  name: 'aya_shell',
  description:
    '在设备上执行一条 adb shell 命令并返回输出（超过 20000 字符会截断）。用于 aya_* 工具未覆盖的场景，例如 dumpsys、settings、am。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const command = String(args.command || '').trim()
    if (!command) {
      throw new McpError('INVALID_ARGS', 'command 不能为空')
    }

    const deviceId = await resolveDeviceId(args.deviceId)
    const output = await base.shell(deviceId, command)
    const truncated = output.length > MAX_OUTPUT
    const errorHint = detectShellError(output)

    await afterInput(deviceId, 0)

    return jsonResult({
      ok: true,
      deviceId,
      command,
      truncated,
      errorHint: errorHint || null,
      output: truncated ? output.slice(0, MAX_OUTPUT) : output,
    })
  },
}

export default [shell]
