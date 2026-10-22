import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import * as file from '../../adb/file'
import * as record from '../../adb/record'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

function normalizeTimeLimit(value: unknown) {
  if (value === undefined || value === null) {
    return record.DEFAULT_TIME_LIMIT
  }
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num) || num < 1 || num > record.MAX_TIME_LIMIT) {
    throw new McpError(
      'INVALID_ARGS',
      `timeLimit 需在 1-${record.MAX_TIME_LIMIT} 秒之间（screenrecord 上限），收到：${String(
        value
      )}`
    )
  }

  return num
}

function normalizeBitRate(value: unknown) {
  if (value === undefined || value === null) {
    return record.DEFAULT_BIT_RATE
  }
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num) || num < 100000 || num > 100000000) {
    throw new McpError(
      'INVALID_ARGS',
      `bitRate 需在 100000-100000000（bps）之间，收到：${String(value)}`
    )
  }

  return num
}

function normalizeSize(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return ''
  }
  if (!/^\d{2,5}x\d{2,5}$/.test(raw)) {
    throw new McpError(
      'INVALID_ARGS',
      `size 需形如 720x1280，收到：${raw}`
    )
  }

  return raw
}

const startRecording: McpTool = {
  name: 'aya_start_recording',
  description:
    '开始录屏（设备端 screenrecord，后台运行）。立即返回，随后继续 aya_tap / aya_batch 等操作即可，结束时调用 aya_stop_recording 把视频拉回本机。默认 180 秒后设备自动停止，超过需分段录制。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      timeLimit: {
        type: 'number',
        description: `最长录制秒数，1-${record.MAX_TIME_LIMIT}，默认 ${record.DEFAULT_TIME_LIMIT}`,
      },
      bitRate: {
        type: 'number',
        description: '码率 bps，默认 8000000（8Mbps）',
      },
      size: {
        type: 'string',
        description: '分辨率上限，如 720x1280，建议 8 的倍数；省略用设备原分辨率',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const timeLimit = normalizeTimeLimit(args.timeLimit)
    const bitRate = normalizeBitRate(args.bitRate)
    const size = normalizeSize(args.size)

    let recording: Awaited<ReturnType<typeof record.startRecording>>
    try {
      recording = await record.startRecording(deviceId, {
        timeLimit,
        bitRate,
        size,
      })
    } catch (err) {
      throw new McpError(
        'INVALID_ARGS',
        err instanceof Error ? err.message : String(err)
      )
    }

    return jsonResult({
      ok: true,
      deviceId,
      remotePath: recording.remotePath,
      timeLimit,
      bitRate,
      size: size || 'original',
      hint: `录屏已开始，最多 ${timeLimit} 秒后自动停止；结束请调用 aya_stop_recording 拉取视频`,
    })
  },
}

const stopRecording: McpTool = {
  name: 'aya_stop_recording',
  description:
    '停止录屏并把视频拉回本机。省略 localPath 时保存到系统临时目录 aya-mcp/ 下并返回绝对路径；默认删除设备上的临时文件。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      localPath: {
        type: 'string',
        description: '本机保存路径（绝对路径，含文件名），省略则用临时目录',
      },
      keepRemote: {
        type: 'boolean',
        description: '保留设备上的录屏文件（默认删除）',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 180000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)

    let result: Awaited<ReturnType<typeof record.stopRecording>>
    try {
      result = await record.stopRecording(deviceId)
    } catch (err) {
      throw new McpError(
        err instanceof Error && /没有进行中/.test(err.message)
          ? 'NOT_FOUND'
          : 'INTERNAL',
        err instanceof Error ? err.message : String(err)
      )
    }

    if (!result.bytes) {
      throw new McpError(
        'INTERNAL',
        `录屏文件为空或未生成：${result.remotePath}（设备可能不支持录屏或录制时长过短）`
      )
    }

    const localPath = args.localPath
      ? path.resolve(String(args.localPath))
      : path.join(os.tmpdir(), 'aya-mcp', path.basename(result.remotePath))
    await fs.ensureDir(path.dirname(localPath))

    try {
      await file.pullFile(deviceId, result.remotePath, localPath)
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `拉取录屏失败：${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (args.keepRemote !== true) {
      try {
        await record.removeRecordingFile(deviceId, result.remotePath)
      } catch {
        // 清理失败不影响结果，文件仍在设备上
      }
    }

    const stat = await fs.stat(localPath)

    return jsonResult({
      ok: true,
      deviceId,
      localPath,
      bytes: stat.size,
      durationMs: result.durationMs,
      remotePath: args.keepRemote === true ? result.remotePath : '',
    })
  },
}

const recordingStatus: McpTool = {
  name: 'aya_recording_status',
  description:
    '查询录屏状态：是否在录制、已录制时长、剩余时长、设备端文件大小。',
  inputSchema: {
    type: 'object',
    properties: { deviceId: deviceIdProperty },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 20000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const status = await record.getRecordingStatus(deviceId)

    return jsonResult({ ok: true, deviceId, ...status })
  },
}

export default [startRecording, stopRecording, recordingStatus]
