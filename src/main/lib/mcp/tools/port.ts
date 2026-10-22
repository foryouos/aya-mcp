import * as port from '../../adb/port'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const directionProperty = {
  type: 'string',
  enum: ['forward', 'reverse'],
  description:
    'forward：本机端口 → 设备端口；reverse：设备端口 → 本机端口',
}

function normalizeEndpoint(value: unknown, field: string) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    throw new McpError('INVALID_ARGS', `${field} 不能为空`)
  }

  if (/^\d+$/.test(raw)) {
    const num = Number(raw)
    if (num < 1 || num > 65535) {
      throw new McpError('INVALID_ARGS', `${field} 端口超出范围：${raw}`)
    }

    return `tcp:${num}`
  }

  if (!/^[a-z]+:.+$/.test(raw)) {
    throw new McpError(
      'INVALID_ARGS',
      `${field} 需形如 8080、tcp:8080 或 localabstract:webview_devtools_remote_1234，收到：${raw}`
    )
  }

  return raw
}

function normalizeDirection(value: unknown) {
  const direction = String(value || 'forward').toLowerCase()
  if (direction !== 'forward' && direction !== 'reverse') {
    throw new McpError(
      'INVALID_ARGS',
      `direction 只能是 forward 或 reverse，收到：${String(value)}`
    )
  }

  return direction as 'forward' | 'reverse'
}

const listPorts: McpTool = {
  name: 'aya_list_ports',
  description:
    '列出当前端口映射：forward（本机 → 设备）与 reverse（设备 → 本机）。调试设备上的 HTTP 服务、WebView 调试端口前先看这里。',
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
    const [forwards, reverses] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    return jsonResult({ ok: true, deviceId, forwards, reverses })
  },
}

const addPort: McpTool = {
  name: 'aya_add_port',
  description:
    '添加端口映射。direction=forward：把本机 local 端口转发到设备 remote（例如 local 8080 → remote tcp:8080，用于访问设备上的 HTTP 服务）；direction=reverse：把设备 remote 端口转发到本机 local（用于让设备访问本机的 mock 服务）。端口可写 8080、tcp:8080 或 localabstract:xxx。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      direction: directionProperty,
      local: { type: 'string', description: '本机端口，如 8080 或 tcp:8080' },
      remote: {
        type: 'string',
        description: '设备端口，如 tcp:8080 或 localabstract:name',
      },
    },
    required: ['local', 'remote'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const direction = normalizeDirection(args.direction)
    const local = normalizeEndpoint(args.local, 'local')
    const remote = normalizeEndpoint(args.remote, 'remote')

    try {
      if (direction === 'forward') {
        await port.forward(deviceId, local, remote)
      } else {
        await port.reverse(deviceId, remote, local)
      }
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `添加端口映射失败：${err instanceof Error ? err.message : String(err)}`
      )
    }

    const [forwards, reverses] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    return jsonResult({
      ok: true,
      deviceId,
      direction,
      local,
      remote,
      forwards,
      reverses,
    })
  },
}

const removePort: McpTool = {
  name: 'aya_remove_port',
  description:
    '移除端口映射。forward 按 local 移除，reverse 按 remote 移除；all:true 清空该方向的所有映射。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      direction: directionProperty,
      local: { type: 'string', description: 'forward：本机端口' },
      remote: { type: 'string', description: 'reverse：设备端口' },
      all: { type: 'boolean', description: '清空该方向的全部映射' },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const direction = normalizeDirection(args.direction)

    let target: string
    if (args.all === true) {
      target = 'all'
    } else if (direction === 'forward') {
      target = normalizeEndpoint(args.local, 'local')
    } else {
      target = normalizeEndpoint(args.remote, 'remote')
    }

    try {
      if (direction === 'forward') {
        await port.removeForward(target)
      } else {
        await port.removeReverse(target)
      }
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        err instanceof Error ? err.message : String(err)
      )
    }

    const [forwards, reverses] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    return jsonResult({
      ok: true,
      deviceId,
      direction,
      removed: target,
      forwards,
      reverses,
    })
  },
}

export default [listPorts, addPort, removePort]
