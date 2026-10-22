import * as adb from '../../adb'
import { getProcesses } from '../../adb/base'
import { getFps } from '../../adb/fps'
import { getTopPackage } from '../../adb/package'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const performance: McpTool = {
  name: 'aya_performance',
  description:
    '获取性能快照：CPU 各核负载与温度、内存占用、电量、开机时长、前台应用帧率。适合在操作后检查卡顿/发热/内存是否异常。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      includeFps: {
        type: 'boolean',
        description: '是否读取前台应用帧率（默认 true，会多花约 200ms）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const perf = await adb.getPerformance(deviceId)
    const uptimeMs = await adb.getUptime(deviceId).catch(() => 0)

    const foreground = await getTopPackage(deviceId).catch(() => null)
    let fps: number | null = null
    if (args.includeFps !== false && foreground && foreground.name) {
      fps = await getFps(deviceId, foreground.name).catch(() => null)
    }

    const memTotal = Number(perf.memTotal) || 0
    const memUsed = Number(perf.memUsed) || 0

    return jsonResult({
      ok: true,
      deviceId,
      cpu: {
        loads: perf.cpuLoads,
        temperature: perf.cpuTemperature ?? null,
        cores: (perf.cpus || []).length,
      },
      memory: {
        totalMB: Math.round(memTotal / 1024 / 1024),
        usedMB: Math.round(memUsed / 1024 / 1024),
        usagePercent: memTotal
          ? Math.round((memUsed / memTotal) * 1000) / 10
          : null,
      },
      battery: {
        level: perf.batteryLevel ?? null,
        temperature: perf.batteryTemperature ?? null,
        voltage: perf.batteryVoltage ?? null,
      },
      uptimeMs,
      foreground,
      fps,
    })
  },
}

const listProcesses: McpTool = {
  name: 'aya_list_processes',
  description:
    '列出设备上正在运行的进程（名称 + pid）。可按名称子串过滤，用于确认应用是否存活、查找残留进程。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      filter: {
        type: 'string',
        description: '按进程名做不区分大小写的子串过滤，如 tencent',
      },
      limit: {
        type: 'number',
        description: '最多返回多少条（默认 100，上限 500）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    let list = await getProcesses(deviceId)

    if (!Array.isArray(list)) {
      throw new McpError('INTERNAL', '读取进程列表失败')
    }

    const total = list.length
    const keyword = String(args.filter || '')
      .trim()
      .toLowerCase()
    if (keyword) {
      list = list.filter((item) => item.name.toLowerCase().includes(keyword))
    }

    const limit = Math.min(
      Math.max(Math.floor(Number(args.limit) || 100), 1),
      500
    )

    return jsonResult({
      ok: true,
      deviceId,
      total,
      matched: list.length,
      truncated: list.length > limit,
      processes: list.slice(0, limit).map((item) => ({
        name: item.name,
        pid: Number(item.pid),
      })),
    })
  },
}

export default [performance, listProcesses]
