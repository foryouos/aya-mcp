import fs from 'node:fs'
import * as base from '../../adb/base'
import * as pkg from '../../adb/package'
import { afterInput } from '../lib/action'
import { resolveDeviceId } from '../lib/device'
import { parseDumpsysPackage, parsePackageList } from '../lib/parse'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const packageProperty = {
  type: 'string',
  description: '应用包名，如 com.tencent.mm。可用 aya_list_packages 查询',
}

const settleProperty = {
  type: 'number',
  description: '操作后等待的毫秒数（默认 300），等待 UI 稳定',
}

function requirePackage(value: unknown): string {
  const name = String(value || '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(name)) {
    throw new McpError(
      'INVALID_ARGS',
      `包名不合法：${name || '(空)'}，应形如 com.example.app`
    )
  }

  return name
}

async function isInstalled(deviceId: string, name: string): Promise<boolean> {
  const output = await base.shell(deviceId, `pm path ${name}`)

  return /^package:/m.test(output)
}

async function listPackageNames(
  deviceId: string,
  option: string
): Promise<string[]> {
  const output = await base.shell(deviceId, `pm list packages ${option}`)

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length))
}

const listPackages: McpTool = {
  name: 'aya_list_packages',
  description:
    '列出设备上已安装的应用包名（含 apk 路径与是否为系统应用）。可按关键字过滤、只看第三方应用。不返回图标与显示名。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      filter: {
        type: 'string',
        description: '按包名做不区分大小写的子串过滤，如 tencent',
      },
      thirdPartyOnly: {
        type: 'boolean',
        description: '仅返回第三方应用（默认 false，即包含系统应用）',
      },
      limit: {
        type: 'number',
        description: '最多返回多少条（默认 100，上限 1000）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const output = await base.shell(deviceId, 'pm list packages -f')
    const all = parsePackageList(output)

    const keyword = String(args.filter || '')
      .trim()
      .toLowerCase()
    let matched = args.thirdPartyOnly ? all.filter((item) => !item.system) : all
    if (keyword) {
      matched = matched.filter((item) =>
        item.name.toLowerCase().includes(keyword)
      )
    }

    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 100), 1), 1000)

    return jsonResult({
      ok: true,
      deviceId,
      total: all.length,
      matched: matched.length,
      truncated: matched.length > limit,
      packages: matched.slice(0, limit).map((item) => ({
        name: item.name,
        system: item.system,
        apkPath: item.apkPath,
      })),
    })
  },
}

const appInfo: McpTool = {
  name: 'aya_app_info',
  description:
    '查询单个应用的详情：是否安装、是否在运行与 pid、版本号、sdk 版本、安装/更新时间、是否为系统应用、是否被禁用、apk 路径。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const deviceId = await resolveDeviceId(args.deviceId)

    if (!(await isInstalled(deviceId, packageName))) {
      throw new McpError('NOT_FOUND', `应用未安装：${packageName}`)
    }

    const [apkOutput, dump, disabled, pidOutput] = [
      await base.shell(deviceId, `pm path ${packageName}`),
      await base.shell(deviceId, `dumpsys package ${packageName}`),
      await listPackageNames(deviceId, '-d'),
      await base.shell(deviceId, `pidof ${packageName}`),
    ]

    const info = parseDumpsysPackage(dump)
    const pid = parseInt(pidOutput.trim().split(/\s+/)[0], 10)

    return jsonResult({
      ok: true,
      deviceId,
      package: packageName,
      apkPaths: apkOutput
        .split(/\r?\n/)
        .map((line) => line.replace(/^package:/, '').trim())
        .filter(Boolean),
      enabled: !disabled.includes(packageName),
      running: !isNaN(pid),
      pid: isNaN(pid) ? null : pid,
      ...info,
    })
  },
}

const startApp: McpTool = {
  name: 'aya_start_app',
  description:
    '启动应用的 Launcher Activity（等价于点击桌面图标）。应用未安装会返回 NOT_FOUND。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      settle: settleProperty,
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const deviceId = await resolveDeviceId(args.deviceId)

    try {
      await pkg.startPackage(deviceId, packageName)
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `启动 ${packageName} 失败：${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    const settle = Number(args.settle ?? 800)
    await afterInput(deviceId, settle)

    return jsonResult({ ok: true, deviceId, package: packageName, settledMs: settle })
  },
}

const stopApp: McpTool = {
  name: 'aya_stop_app',
  description:
    '强制停止应用（am force-stop），进程会被立即杀死。比 aya_key back 更彻底。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      settle: settleProperty,
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const deviceId = await resolveDeviceId(args.deviceId)

    await pkg.stopPackage(deviceId, packageName)
    const settle = Number(args.settle ?? 300)
    await afterInput(deviceId, settle)

    return jsonResult({ ok: true, deviceId, package: packageName, settledMs: settle })
  },
}

const clearAppData: McpTool = {
  name: 'aya_clear_app_data',
  description:
    '清除应用的全部数据与缓存（pm clear），等价于系统设置里的“清除数据”。不可撤销。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      settle: settleProperty,
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const deviceId = await resolveDeviceId(args.deviceId)

    await pkg.clearPackage(deviceId, packageName)
    const settle = Number(args.settle ?? 300)
    await afterInput(deviceId, settle)

    return jsonResult({ ok: true, deviceId, package: packageName, settledMs: settle })
  },
}

const setAppEnabled: McpTool = {
  name: 'aya_set_app_enabled',
  description:
    '启用或禁用应用（pm enable / pm disable-user）。禁用后应用图标与桌面入口消失，重新启用即可恢复。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      enabled: { type: 'boolean', description: 'true 启用，false 禁用' },
      settle: settleProperty,
    },
    required: ['package', 'enabled'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const enabled = args.enabled !== false
    const deviceId = await resolveDeviceId(args.deviceId)

    if (enabled) {
      await pkg.enablePackage(deviceId, packageName)
    } else {
      await pkg.disablePackage(deviceId, packageName)
    }

    const settle = Number(args.settle ?? 300)
    await afterInput(deviceId, settle)

    return jsonResult({
      ok: true,
      deviceId,
      package: packageName,
      enabled,
      settledMs: settle,
    })
  },
}

const uninstallApp: McpTool = {
  name: 'aya_uninstall_app',
  description:
    '卸载应用。系统应用通常会失败；卸载后数据一并删除，不可恢复。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      settle: settleProperty,
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: true,
  timeout: 120000,
  handler: async (args) => {
    const packageName = requirePackage(args.package)
    const deviceId = await resolveDeviceId(args.deviceId)

    await pkg.uninstallPackage(deviceId, packageName)
    const settle = Number(args.settle ?? 300)
    await afterInput(deviceId, settle)

    return jsonResult({ ok: true, deviceId, package: packageName, settledMs: settle })
  },
}

const installApp: McpTool = {
  name: 'aya_install_app',
  description:
    '安装本机上的 apk 文件到设备。apkPath 是本机绝对路径（不是设备路径），覆盖安装同一包名会保留数据。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      apkPath: {
        type: 'string',
        description: '本机 apk 文件的绝对路径，如 C:\\\\tmp\\\\app.apk',
      },
      settle: settleProperty,
    },
    required: ['apkPath'],
    additionalProperties: false,
  },
  write: true,
  timeout: 180000,
  handler: async (args) => {
    const apkPath = String(args.apkPath || '').trim()
    if (!apkPath) {
      throw new McpError('INVALID_ARGS', 'apkPath 不能为空')
    }
    if (!fs.existsSync(apkPath)) {
      throw new McpError('NOT_FOUND', `本机文件不存在：${apkPath}`)
    }

    const deviceId = await resolveDeviceId(args.deviceId)
    await pkg.installPackage(deviceId, apkPath)

    return jsonResult({ ok: true, deviceId, apkPath, installed: true })
  },
}

export default [
  listPackages,
  appInfo,
  startApp,
  stopApp,
  clearAppData,
  setAppEnabled,
  uninstallApp,
  installApp,
]
