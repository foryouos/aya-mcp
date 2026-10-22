import pkg from '../../../../package.json'
import { findTool, getToolSchema, getVisibleTools } from './tools'
import { errorResult, McpError, withTimeout } from './lib/result'
import log from 'share/common/log'

const logger = log('mcp')

export const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const TOOL_TIMEOUT = 15000
export const SERVER_INFO = { name: 'aya', version: pkg.version }

interface IRpcError {
  code: number
  message: string
  data?: unknown
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  const error: IRpcError = { code, message }
  if (data !== undefined) {
    error.data = data
  }

  return { jsonrpc: '2.0', id, error }
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function negotiateVersion(requested: unknown) {
  if (
    typeof requested === 'string' &&
    SUPPORTED_VERSIONS.includes(requested)
  ) {
    return requested
  }

  return PROTOCOL_VERSION
}

function listTools() {
  return {
    tools: getVisibleTools().map(getToolSchema),
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = findTool(name)
  if (!tool) {
    return errorResult(
      new McpError(
        'INVALID_ARGS',
        `工具 ${name} 不存在或当前不可用（写操作需在 AYA 设置中开启“允许写操作”）`
      )
    )
  }

  try {
    return await withTimeout(
      tool.handler(args || {}),
      tool.timeout || (tool.name === 'aya_shell' ? 30000 : TOOL_TIMEOUT),
      tool.name
    )
  } catch (err) {
    logger.error('tool failed', name, err instanceof Error ? err.message : err)

    return errorResult(err)
  }
}

export async function handleMessage(msg: any): Promise<any | null> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null

    return rpcError(id, -32600, 'Invalid Request')
  }

  const { id, method, params } = msg
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateVersion(params && params.protocolVersion),
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: SERVER_INFO,
        instructions:
          'AYA 提供 Android 设备控制。先用 aya_list_devices 确认设备，用 aya_ui_dump 获取带坐标的界面节点树，再调用 aya_tap / aya_swipe 操作。',
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return isNotification ? null : rpcResult(id, {})
    case 'tools/list':
      return isNotification ? null : rpcResult(id, listTools())
    case 'tools/call': {
      const name = params && params.name
      if (typeof name !== 'string') {
        return isNotification
          ? null
          : rpcError(id, -32602, 'Invalid params: name required')
      }
      const args = (params && params.arguments) || {}
      const result = await callTool(name, args)

      return isNotification ? null : rpcResult(id, result)
    }
    default:
      return isNotification
        ? null
        : rpcError(id, -32601, `Method not found: ${method}`)
  }
}

export function getToolsSnapshot() {
  return listTools()
}
