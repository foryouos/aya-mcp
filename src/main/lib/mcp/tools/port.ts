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

function normalizeDirection(value: unknown, fallback = 'forward') {
  const direction = String(value || fallback).toLowerCase()
  if (direction !== 'forward' && direction !== 'reverse') {
    throw new McpError(
      'INVALID_ARGS',
      `direction 只能是 forward 或 reverse，收到：${String(value)}`
    )
  }

  return direction as 'forward' | 'reverse'
}

interface IPortEntry {
  local: string
  remote: string
}

// adb 列表里的 endpoint 可能是 tcp:8080，也可能是裸端口，统一后再比对
function sameEndpoint(a: string, b: string) {
  const normalize = (value: string) =>
    /^\d+$/.test(value) ? `tcp:${value}` : value.trim()

  return normalize(a) === normalize(b)
}

function findForward(list: IPortEntry[], local: string) {
  return list.find((item) => sameEndpoint(item.local, local))
}

// reverse 的 local/remote 语义随 adb 版本可能互换，两端都匹配更稳
function findReverse(list: IPortEntry[], devicePort: string) {
  return list.find(
    (item) =>
      sameEndpoint(item.local, devicePort) || sameEndpoint(item.remote, devicePort)
  )
}

function reverseTarget(entry: IPortEntry, devicePort: string) {
  return sameEndpoint(entry.local, devicePort) ? entry.remote : entry.local
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
    '添加端口映射。direction=forward：把本机 local 端口转发到设备 remote（例如 local 8080 → remote tcp:8080，用于访问设备上的 HTTP 服务）；direction=reverse：把设备 remote 端口转发到本机 local（用于让设备访问本机的 mock 服务）。端口可写 8080、tcp:8080 或 localabstract:xxx。相同映射已存在时直接返回 existed:true 不重复执行；已有同端口但目标不同时需显式传 replace:true 才会覆盖。',
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
      replace: {
        type: 'boolean',
        description: '同端口已映射到其它目标时是否覆盖（默认 false，避免误改调试端口）',
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

    const [forwardsBefore, reversesBefore] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    const existing =
      direction === 'forward'
        ? findForward(forwardsBefore, local)
        : findReverse(reversesBefore, remote)
    let existed = false
    let replaced = false

    if (existing) {
      const currentTarget =
        direction === 'forward'
          ? existing.remote
          : reverseTarget(existing, remote)
      existed = sameEndpoint(currentTarget, direction === 'forward' ? remote : local)

      if (!existed) {
        if (args.replace !== true) {
          throw new McpError(
            'INVALID_ARGS',
            `${direction} 端口 ${direction === 'forward' ? local : remote} 已映射到 ${currentTarget}；如需改指向请传 replace:true`
          )
        }

        try {
          if (direction === 'forward') {
            await port.removeForward(deviceId, local)
          } else {
            await port.removeReverse(deviceId, remote)
          }
        } catch (err) {
          throw new McpError(
            'INTERNAL',
            `覆盖旧映射失败：${err instanceof Error ? err.message : String(err)}`
          )
        }
        replaced = true
      }
    }

    if (!existed) {
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
      existed,
      replaced,
      changed: !existed,
      forwards,
      reverses,
      hint: existed
        ? '该映射已存在，未重复执行'
        : replaced
          ? '已覆盖原有同端口映射'
          : undefined,
    })
  },
}

const removePort: McpTool = {
  name: 'aya_remove_port',
  description:
    '移除端口映射。forward 按 local 移除，reverse 按 remote 移除；direction 省略时按「端口出现在哪个列表」自动推断并在返回里回显；all:true 清空该方向的所有映射。不存在时返回 existed:false 而不是报错。',
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
    const [forwardsBefore, reversesBefore] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    let direction: 'forward' | 'reverse'
    let inferred = false

    if (args.direction !== undefined) {
      direction = normalizeDirection(args.direction)
    } else if (args.all === true) {
      direction = 'forward'
      inferred = true
    } else if (args.local && findForward(forwardsBefore, String(args.local))) {
      direction = 'forward'
      inferred = true
    } else if (args.remote && findReverse(reversesBefore, String(args.remote))) {
      direction = 'reverse'
      inferred = true
    } else if (args.local && !args.remote) {
      direction = 'forward'
      inferred = true
    } else if (args.remote && !args.local) {
      direction = 'reverse'
      inferred = true
    } else {
      throw new McpError(
        'INVALID_ARGS',
        '无法推断方向：请传 direction，或只传 local（forward）/ remote（reverse）'
      )
    }

    let target: string
    if (args.all === true) {
      target = 'all'
    } else if (direction === 'forward') {
      target = normalizeEndpoint(args.local, 'local')
    } else {
      target = normalizeEndpoint(args.remote, 'remote')
    }

    const existed =
      target === 'all'
        ? (direction === 'forward' ? forwardsBefore.length : reversesBefore.length) >
          0
        : !!((direction === 'forward'
          ? findForward(forwardsBefore, target)
          : findReverse(reversesBefore, target)))

    if (existed) {
      try {
        if (direction === 'forward') {
          await port.removeForward(deviceId, target)
        } else {
          await port.removeReverse(deviceId, target)
        }
      } catch (err) {
        throw new McpError(
          'INTERNAL',
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    const [forwards, reverses] = await Promise.all([
      port.listForwards(deviceId),
      port.listReverses(deviceId),
    ])

    return jsonResult({
      ok: true,
      deviceId,
      direction,
      inferred,
      removed: target,
      existed,
      changed: existed,
      forwards,
      reverses,
      hint: existed ? undefined : '该方向下没有匹配的映射，未执行删除',
    })
  },
}

export default [listPorts, addPort, removePort]
