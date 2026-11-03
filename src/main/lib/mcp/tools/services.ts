import {
  collectServiceDumpsys,
  collectServices,
  collectServiceBinder,
  collectServiceProcess,
} from '../../adb/services'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id（如 emulator-5554）。省略时使用 AYA 当前选中设备',
}

const listServices: McpTool = {
  name: 'aya_list_services',
  description:
    '列出设备上的服务并区分类型。system 包含 servicemanager（Java 系统服务 / Native Binder / AIDL HAL）与 hwservicemanager（HIDL HAL）；app 为应用声明并运行中的 Service 组件。每条含 PID、进程名、SELinux domain、类型、状态、RSS，HIDL HAL 额外带 binder 线程数。group 可按 HAL / Java / Vendor 过滤。只读，不改变设备状态。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      type: {
        type: 'string',
        enum: ['system', 'app', 'all'],
        description: '要查询的服务类型，默认 all',
      },
      group: {
        type: 'string',
        enum: ['all', 'hal', 'java', 'vendor'],
        description:
          '分类过滤：hal = AIDL/HIDL HAL，java = Java 系统服务，vendor = vendor 专有，默认 all',
      },
      filter: {
        type: 'string',
        description: '按服务名 / 接口 / 进程名 / PID 做不区分大小写的子串过滤',
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
  timeout: 90000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const type = String(args.type || 'all').toLowerCase()
    if (['system', 'app', 'all'].indexOf(type) < 0) {
      throw new McpError(
        'INVALID_ARGS',
        `type 只能是 system / app / all，收到：${type}`
      )
    }
    const group = String(args.group || 'all').toLowerCase()
    if (['all', 'hal', 'java', 'vendor'].indexOf(group) < 0) {
      throw new McpError(
        'INVALID_ARGS',
        `group 只能是 all / hal / java / vendor，收到：${group}`
      )
    }
    const filter = String(args.filter || '')
      .trim()
      .toLowerCase()
    const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000)

    const all = await collectServices(deviceId)

    const matched = all.filter((service) => {
      if (type !== 'all' && service.origin !== type) {
        return false
      }
      if (group === 'hal' && !service.kind.endsWith('-hal')) {
        return false
      }
      if (group === 'java' && service.kind !== 'java-system') {
        return false
      }
      if (group === 'vendor' && !service.vendor) {
        return false
      }
      if (!filter) {
        return true
      }

      return `${service.name} ${service.descriptor} ${service.processName} ${service.pid}`
        .toLowerCase()
        .includes(filter)
    })

    return jsonResult({
      deviceId,
      total: all.length,
      matched: matched.length,
      returned: Math.min(matched.length, limit),
      truncated: matched.length > limit,
      services: matched.slice(0, limit),
    })
  },
}

const serviceInfo: McpTool = {
  name: 'aya_service_info',
  description:
    '查看单个服务的诊断信息，按 section 返回：dumpsys（可带 args，如 meminfo）、process（init rc、UID/GID/RSS、/dev 与 /sys 节点，无 root 时 fd 会被标记为 denied）、binder（/d/binder/proc 的线程数与入向引用 PID）。只读。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      kind: {
        type: 'string',
        enum: ['system', 'app'],
        description: '服务类型，默认 system',
      },
      name: {
        type: 'string',
        description: '系统服务名（如 activity / window），或 包名/类名',
      },
      args: {
        type: 'string',
        description: '追加到 dumpsys 的参数，如 meminfo / --latency',
      },
      sections: {
        type: 'array',
        items: { type: 'string', enum: ['dumpsys', 'process', 'binder'] },
        description:
          '要返回哪些 section，默认 ["dumpsys"]；process / binder 需要该服务有 PID',
      },
      pid: {
        type: 'number',
        description: '服务所在进程 PID，可省略；省略时自动从服务列表里查',
      },
      maxBytes: {
        type: 'number',
        description: 'dumpsys 原文最大返回字节数，默认 20000',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 90000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const kind = String(args.kind || 'system').toLowerCase()
    if (kind !== 'system' && kind !== 'app') {
      throw new McpError(
        'INVALID_ARGS',
        `kind 只能是 system / app，收到：${kind}`
      )
    }
    const name = String(args.name || '').trim()
    if (!name) {
      throw new McpError('INVALID_ARGS', 'name 不能为空')
    }

    const sections: string[] = Array.isArray(args.sections)
      ? args.sections.map((item: unknown) => String(item))
      : ['dumpsys']
    const maxBytes = Math.min(Math.max(Number(args.maxBytes) || 20000, 1000), 200000)

    let pid = Math.max(0, Math.floor(Number(args.pid) || 0))
    let processName = ''
    if (!pid && (sections.includes('process') || sections.includes('binder'))) {
      const all = await collectServices(deviceId)
      const found = all.find(
        (service) =>
          service.name === name ||
          `${service.packageName}/${service.className}` === name ||
          service.className === name
      )
      if (found) {
        pid = found.pid
        processName = found.processName
      }
    }

    const result: Record<string, unknown> = {
      deviceId,
      kind,
      name,
      pid,
    }

    if (sections.includes('dumpsys')) {
      const output = await collectServiceDumpsys(
        deviceId,
        kind as 'system' | 'app',
        name,
        String(args.args || '')
      )
      result.dumpsys = {
        bytes: Buffer.byteLength(output),
        truncated: Buffer.byteLength(output) > maxBytes,
        output:
          Buffer.byteLength(output) > maxBytes
            ? output.slice(0, maxBytes)
            : output,
      }
    }

    if (sections.includes('process')) {
      result.process = await collectServiceProcess(deviceId, pid, processName)
    }

    if (sections.includes('binder')) {
      result.binder = await collectServiceBinder(deviceId, pid)
    }

    return jsonResult(result)
  },
}

export default [listServices, serviceInfo]
