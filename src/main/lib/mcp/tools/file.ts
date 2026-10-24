import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import * as file from '../../adb/file'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const remotePathProperty = {
  type: 'string',
  description: '设备上的绝对路径，如 /sdcard/DCIM/',
}

// 顶层目录一旦删除几乎等于清空设备，直接拒绝
const FORBIDDEN_PATHS = ['/', '/sdcard', '/storage', '/data', '/system', '/vendor']

function normalizeRemote(raw: unknown): string {
  const value = String(raw || '').trim()
  if (!value) {
    throw new McpError('INVALID_ARGS', '路径不能为空')
  }
  if (!value.startsWith('/')) {
    throw new McpError('INVALID_ARGS', `设备路径必须是绝对路径：${value}`)
  }

  return value
}

function requireSafeDeleteTarget(value: string) {
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || FORBIDDEN_PATHS.includes(normalized)) {
    throw new McpError('INVALID_ARGS', `拒绝删除顶层目录：${value}`)
  }
}

async function statRemote(deviceId: string, remotePath: string) {
  try {
    return await file.statFile(deviceId, remotePath)
  } catch (err) {
    throw new McpError(
      'NOT_FOUND',
      `无法访问设备路径 ${remotePath}：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

// 探测路径是否存在：不存在返回 null，避免把「不存在」当成错误抛出
async function tryStat(deviceId: string, remotePath: string) {
  try {
    return await file.statFile(deviceId, remotePath)
  } catch {
    return null
  }
}

function toMcpError(action: string, err: unknown) {
  return new McpError(
    'INTERNAL',
    `${action}：${err instanceof Error ? err.message : String(err)}`
  )
}

// 去掉末尾多余的 /，用于拼接目录下的文件名
function trimSlash(value: string) {
  return value.replace(/\/+$/, '')
}

const listDir: McpTool = {
  name: 'aya_list_dir',
  description:
    '列出设备目录内容（名称、类型、大小、修改时间）。用于查找截图、日志、数据库等文件。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      path: {
        type: 'string',
        description: '设备目录绝对路径，默认 /sdcard/',
      },
      filter: {
        type: 'string',
        description: '按文件名做不区分大小写的子串过滤',
      },
      limit: {
        type: 'number',
        description: '最多返回多少条（默认 200，上限 1000）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = args.path ? normalizeRemote(args.path) : '/sdcard/'

    let entries: Awaited<ReturnType<typeof file.readDir>>
    try {
      entries = await file.readDir(deviceId, remotePath)
    } catch (err) {
      throw new McpError(
        'NOT_FOUND',
        `无法读取目录 ${remotePath}：${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    if (!Array.isArray(entries)) {
      throw new McpError('INTERNAL', `读取目录失败：${remotePath}`)
    }

    const total = entries.length
    const keyword = String(args.filter || '')
      .trim()
      .toLowerCase()
    if (keyword) {
      entries = entries.filter((item) =>
        item.name.toLowerCase().includes(keyword)
      )
    }

    entries.sort((a, b) => {
      if (a.directory !== b.directory) {
        return a.directory ? -1 : 1
      }

      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })

    const limit = Math.min(
      Math.max(Math.floor(Number(args.limit) || 200), 1),
      1000
    )

    return jsonResult({
      ok: true,
      deviceId,
      path: remotePath,
      total,
      matched: entries.length,
      truncated: entries.length > limit,
      entries: entries.slice(0, limit).map((item) => ({
        name: item.name,
        type: item.directory ? 'dir' : 'file',
        size: item.size ?? null,
        mtime: item.mtime,
        mime: item.mime ?? null,
      })),
    })
  },
}

const pullFile: McpTool = {
  name: 'aya_pull_file',
  description:
    '把设备上的文件拉取到本机。省略 localPath 时保存到系统临时目录 aya-mcp/ 下，并返回绝对路径。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      remotePath: remotePathProperty,
      localPath: {
        type: 'string',
        description: '本机保存路径（绝对路径，可含目录）。省略则用临时目录',
      },
    },
    required: ['remotePath'],
    additionalProperties: false,
  },
  write: true,
  timeout: 120000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = normalizeRemote(args.remotePath)
    const localPath = args.localPath
      ? path.resolve(String(args.localPath))
      : path.join(os.tmpdir(), 'aya-mcp', path.basename(remotePath))

    await fs.ensureDir(path.dirname(localPath))

    try {
      await file.pullFile(deviceId, remotePath, localPath)
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `拉取失败：${err instanceof Error ? err.message : String(err)}`
      )
    }

    const stat = await fs.stat(localPath)

    return jsonResult({
      ok: true,
      deviceId,
      remotePath,
      localPath,
      bytes: stat.size,
    })
  },
}

const pushFile: McpTool = {
  name: 'aya_push_file',
  description:
    '把本机文件推送到设备。localPath 是本机绝对路径，remotePath 是设备目标路径（目录需以 / 结尾）。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      localPath: { type: 'string', description: '本机文件绝对路径' },
      remotePath: remotePathProperty,
    },
    required: ['localPath', 'remotePath'],
    additionalProperties: false,
  },
  write: true,
  timeout: 120000,
  handler: async (args) => {
    const localPath = path.resolve(String(args.localPath || '').trim())
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = normalizeRemote(args.remotePath)

    if (!fs.existsSync(localPath)) {
      throw new McpError('NOT_FOUND', `本机文件不存在：${localPath}`)
    }

    try {
      await file.pushFile(deviceId, localPath, remotePath)
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `推送失败：${err instanceof Error ? err.message : String(err)}`
      )
    }

    return jsonResult({ ok: true, deviceId, localPath, remotePath })
  },
}

const deletePath: McpTool = {
  name: 'aya_delete_path',
  description:
    '删除设备上的文件或目录（不可恢复）。删除目录必须显式传 recursive: true，否则报错。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      path: remotePathProperty,
      recursive: {
        type: 'boolean',
        description: '删除目录时需为 true（等价 rm -rf）',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = normalizeRemote(args.path)
    requireSafeDeleteTarget(remotePath)

    const info = await statRemote(deviceId, remotePath)
    if (info.directory && args.recursive !== true) {
      throw new McpError(
        'INVALID_ARGS',
        `${remotePath} 是目录，删除目录必须传 recursive: true`
      )
    }

    try {
      if (info.directory) {
        await file.deleteDir(deviceId, remotePath)
      } else {
        await file.deleteFile(deviceId, remotePath)
      }
    } catch (err) {
      throw toMcpError(`删除 ${remotePath} 失败`, err)
    }

    // 设备端 rm 在权限不足时可能既不报错也不删除，必须回查确认
    if (await tryStat(deviceId, remotePath)) {
      throw new McpError(
        'PERMISSION_DENIED',
        `${remotePath} 删除后仍然存在，可能是权限不足`
      )
    }

    return jsonResult({
      ok: true,
      deviceId,
      path: remotePath,
      type: info.directory ? 'dir' : 'file',
      verified: true,
    })
  },
}

const makeDir: McpTool = {
  name: 'aya_make_dir',
  description: '在设备上创建目录（mkdir -p，父目录不存在会自动创建）。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      path: {
        type: 'string',
        description: '要创建的设备目录绝对路径，如 /sdcard/aya/cases',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = normalizeRemote(args.path)

    try {
      await file.createDir(deviceId, remotePath)
    } catch (err) {
      throw toMcpError(`创建目录 ${remotePath} 失败`, err)
    }

    const info = await tryStat(deviceId, remotePath)
    if (!info || !info.directory) {
      throw new McpError(
        'INTERNAL',
        `创建目录 ${remotePath} 失败，路径不存在或不是目录`
      )
    }

    return jsonResult({
      ok: true,
      deviceId,
      path: remotePath,
      verified: true,
    })
  },
}

const renamePath: McpTool = {
  name: 'aya_rename_path',
  description: '重命名或移动设备上的文件/目录。目标已存在时行为由 mv 决定（可能覆盖）。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      from: remotePathProperty,
      to: { type: 'string', description: '目标设备绝对路径' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const from = normalizeRemote(args.from)
    const to = normalizeRemote(args.to)
    requireSafeDeleteTarget(from)

    if (trimSlash(from) === trimSlash(to)) {
      throw new McpError('INVALID_ARGS', 'from 与 to 相同，无需移动')
    }

    const fromInfo = await statRemote(deviceId, from)
    const destInfo = await tryStat(deviceId, to)
    // 目标是已存在的目录时，mv 会把源放进该目录下
    const target =
      destInfo && destInfo.directory
        ? `${trimSlash(to)}/${path.basename(trimSlash(from))}`
        : to
    const overwritten = !!destInfo && !destInfo.directory

    try {
      await file.moveFile(deviceId, from, target)
    } catch (err) {
      throw toMcpError(`移动 ${from} -> ${target} 失败`, err)
    }

    const result = await tryStat(deviceId, target)
    if (!result) {
      throw new McpError(
        'INTERNAL',
        `移动后目标路径不存在：${target}（设备端 mv 未生效）`
      )
    }
    if (await tryStat(deviceId, from)) {
      throw new McpError('INTERNAL', `移动后源路径仍然存在：${from}`)
    }
    if (!fromInfo.directory && result.size !== fromInfo.size) {
      throw new McpError(
        'INTERNAL',
        `移动后大小不一致：源 ${fromInfo.size} 字节，目标 ${result.size} 字节`
      )
    }

    return jsonResult({
      ok: true,
      deviceId,
      from,
      to: target,
      overwritten,
      verified: true,
      type: result.directory ? 'dir' : 'file',
      size: result.size ?? null,
    })
  },
}

const statPath: McpTool = {
  name: 'aya_stat_path',
  description:
    '查询设备路径的属性：是否存在、是文件还是目录、大小、权限、修改时间。删除/拉取前可先确认。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      path: remotePathProperty,
    },
    required: ['path'],
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const remotePath = normalizeRemote(args.path)
    const info = await statRemote(deviceId, remotePath)

    return jsonResult({
      ok: true,
      deviceId,
      path: remotePath,
      exists: true,
      type: info.directory ? 'dir' : 'file',
      size: info.size ?? null,
      mode: info.mode,
      mtime: info.mtime,
    })
  },
}

export default [
  listDir,
  statPath,
  pullFile,
  pushFile,
  deletePath,
  makeDir,
  renamePath,
]
