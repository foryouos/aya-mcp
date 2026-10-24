import fs from 'node:fs'
import * as base from '../../adb/base'
import * as adbFile from '../../adb/file'
import * as pkg from '../../adb/package'
import { afterInput, sleep } from '../lib/action'
import { dumpFast } from '../lib/dump'
import { resolveDeviceId } from '../lib/device'
import { parseDumpsysPackage, parsePackageList } from '../lib/parse'
import { parseSnapshot } from '../lib/snapshot'
import { jsonResult, McpError } from '../lib/result'
import { findMatches, labelNode } from '../lib/ui'
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
    const apkPaths = apkOutput
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean)

    // base.apk 大小：判断包体是否异常（0 字节说明安装损坏）
    let apkSize: number | null = null
    if (apkPaths[0]) {
      const sizeOutput = await base
        .shell(deviceId, `ls -lL "${apkPaths[0]}"`)
        .catch(() => '')
      const fields = String(sizeOutput).trim().split(/\s+/)
      const size = Number(fields[4])
      if (Number.isFinite(size) && size > 0) {
        apkSize = size
      }
    }

    // 签名指纹：dumpsys 里是签名数组的 hashCode，跨版本格式不同，取不到就返回 null
    const signature =
      dump.match(/signatures=PackageSignatures\{\S*\s*\[([0-9a-fA-F]{8,})\]/)?.[1] ||
      dump.match(/\[([0-9a-fA-F]{32,})\]/)?.[1] ||
      null
    const installer =
      dump.match(/installerPackageName=(\S+)/)?.[1] || null

    return jsonResult({
      ok: true,
      deviceId,
      package: packageName,
      apkPaths,
      apkSize,
      signature,
      installer,
      enabled: !disabled.includes(packageName),
      running: !isNaN(pid),
      pid: isNaN(pid) ? null : pid,
      ...info,
    })
  },
}

// 取当前前台 Activity（比 dumpsys activity 全量输出快得多）
async function currentTopActivity(deviceId: string) {
  const output = await base.shell(
    deviceId,
    "dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity'"
  )
  const match = String(output).match(/([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/)

  return match ? { package: match[1], activity: match[2] } : null
}

// 轮询等待前台切到目标应用，替代固定 sleep；返回是否等到
async function waitForeground(deviceId: string, name: string, timeout: number) {
  const started = Date.now()
  for (;;) {
    const top = await currentTopActivity(deviceId).catch(() => null)
    if (top && top.package === name) {
      return { matched: true, waitedMs: Date.now() - started, top }
    }
    if (Date.now() - started >= timeout) {
      return { matched: false, waitedMs: Date.now() - started, top }
    }
    await sleep(120)
  }
}

// 等界面里出现指定文本/资源 id（启动后等首页加载）
async function waitUi(deviceId: string, text: string, id: string, timeout: number) {
  const started = Date.now()
  for (;;) {
    const dump = await dumpFast(deviceId)
    const snapshot = parseSnapshot(deviceId, dump.xml, true)
    const hits = findMatches(snapshot.flat, { text, id, exact: false })
    if (hits.length) {
      return {
        matched: true,
        waitedMs: Date.now() - started,
        node: labelNode(hits[0]),
      }
    }
    if (Date.now() - started >= timeout) {
      return { matched: false, waitedMs: Date.now() - started, node: null }
    }
    await sleep(200)
  }
}

const startApp: McpTool = {
  name: 'aya_start_app',
  description:
    '启动应用的 Launcher Activity（等价于点击桌面图标）。默认轮询等待前台切到目标应用（不再固定 sleep 800ms，命中即返回），可用 waitFor/waitForId 进一步等到某个控件出现（冷启动首页加载完成）。应用未安装会返回 NOT_FOUND。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      waitFor: {
        type: 'string',
        description: '启动后等待该文本出现（最多等到 timeout），如首页标题',
      },
      waitForId: {
        type: 'string',
        description: '启动后等待该 resource-id 出现',
      },
      timeout: {
        type: 'number',
        description: '等待前台/控件的超时毫秒数，默认 5000',
      },
      settle: {
        type: 'number',
        description: '命中后额外等待的毫秒数，默认 0',
      },
    },
    required: ['package'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
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

    const timeout = Math.min(
      Math.max(Math.floor(Number(args.timeout) || 5000), 500),
      30000
    )
    const foreground = await waitForeground(deviceId, packageName, timeout)

    const payload: any = {
      ok: true,
      deviceId,
      package: packageName,
      foreground: foreground.matched,
      foregroundWaitedMs: foreground.waitedMs,
      topActivity: foreground.top ? `${foreground.top.package}/${foreground.top.activity}` : null,
    }

    const waitText = String(args.waitFor || '').trim()
    const waitId = String(args.waitForId || '').trim()
    if (waitText || waitId) {
      const ui = await waitUi(
        deviceId,
        waitText,
        waitId,
        Math.max(timeout - foreground.waitedMs, 1000)
      )
      payload.uiMatched = ui.matched
      payload.uiWaitedMs = ui.waitedMs
      payload.node = ui.node
      if (!ui.matched) {
        payload.hint = `等了 ${ui.waitedMs}ms 仍未出现 ${
          waitText || waitId
        }；可能还在加载，用 aya_wait_for 继续等，或 aya_ui_dump 看当前界面`
      }
    }

    const settle = Math.max(Number(args.settle ?? 0), 0)
    if (settle > 0) {
      await afterInput(deviceId, settle)
      payload.settledMs = settle
    } else {
      await afterInput(deviceId, 0)
    }

    return jsonResult(payload)
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
    '卸载应用（默认连数据一起删）。keepData:true 时用 pm uninstall -k 只删 apk 保留数据，便于「装不上/想重置」时保留登录态外的配置。卸载后会回查确认已卸载，避免把设备端静默失败当成功。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      keepData: {
        type: 'boolean',
        description: '是否保留应用数据（pm uninstall -k），默认 false',
      },
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
    const keepData = args.keepData === true

    if (!(await isInstalled(deviceId, packageName))) {
      return jsonResult({
        ok: true,
        deviceId,
        package: packageName,
        alreadyUninstalled: true,
        keptData: keepData,
      })
    }

    // pm uninstall 的失败原因（DELETE_FAILED_*）比 adbkit 抛的错更具体
    const output = await base.shell(
      deviceId,
      `pm uninstall ${keepData ? '-k ' : ''}${packageName}`
    )
    const succeeded = /Success/i.test(output)

    if (!succeeded && !/DELETE_FAILED_OWNER_BLOCKED|not installed/i.test(output)) {
      throw new McpError(
        'INTERNAL',
        `卸载 ${packageName} 失败：${output.trim() || '(无输出)'}。系统应用需要 root 或先禁用`
      )
    }

    const stillInstalled = await isInstalled(deviceId, packageName)
    if (stillInstalled && !keepData) {
      throw new McpError(
        'INTERNAL',
        `${packageName} 卸载后仍存在，可能被设备管理员/系统应用保护`
      )
    }

    const settle = Number(args.settle ?? 200)
    await afterInput(deviceId, settle)

    return jsonResult({
      ok: true,
      deviceId,
      package: packageName,
      removed: !stillInstalled,
      keptData: keepData,
      settledMs: settle,
    })
  },
}

const installApp: McpTool = {
  name: 'aya_install_app',
  description:
    '安装 apk 到设备。apkPath 支持本机绝对路径（自动 push 到 /data/local/tmp 后 pm install）或已存在于设备的路径（以 / 开头，省掉一次 push）。默认 -r 覆盖安装并保留数据；支持 downgrade/grant/user。安装后用 pm path 回查确认。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      apkPath: {
        type: 'string',
        description:
          'apk 路径：本机绝对路径（如 C:\\\\tmp\\\\app.apk），或设备上的 /data/local/tmp/app.apk',
      },
      replace: {
        type: 'boolean',
        description: '覆盖安装（pm install -r），默认 true',
      },
      downgrade: {
        type: 'boolean',
        description: '允许版本降级（-d），默认 false',
      },
      grant: {
        type: 'boolean',
        description: '自动授予全部运行时权限（-g），默认 false',
      },
      user: {
        type: 'number',
        description: '安装到指定用户（--user N），默认当前用户',
      },
      settle: settleProperty,
    },
    required: ['apkPath'],
    additionalProperties: false,
  },
  write: true,
  timeout: 300000,
  handler: async (args) => {
    const apkPath = String(args.apkPath || '').trim()
    if (!apkPath) {
      throw new McpError('INVALID_ARGS', 'apkPath 不能为空')
    }

    const deviceId = await resolveDeviceId(args.deviceId)
    const isDevicePath = apkPath.startsWith('/')

    let remotePath = apkPath
    let pushed = false
    let tempPath = ''

    if (!isDevicePath) {
      if (!fs.existsSync(apkPath)) {
        throw new McpError('NOT_FOUND', `本机文件不存在：${apkPath}`)
      }
      tempPath = `/data/local/tmp/aya-install-${Date.now()}.apk`
      try {
        await adbFile.pushFile(deviceId, apkPath, tempPath)
      } catch (err) {
        throw new McpError(
          'INTERNAL',
          `推送 apk 失败：${err instanceof Error ? err.message : String(err)}`
        )
      }
      remotePath = tempPath
      pushed = true
    } else {
      const exists = await adbFile.statFile(deviceId, remotePath).catch(() => null)
      if (!exists || exists.directory) {
        throw new McpError('NOT_FOUND', `设备上不存在该 apk：${remotePath}`)
      }
    }

    const flags: string[] = []
    if (args.replace !== false) {
      flags.push('-r')
    }
    if (args.downgrade === true) {
      flags.push('-d')
    }
    if (args.grant === true) {
      flags.push('-g')
    }
    if (typeof args.user === 'number' && args.user >= 0) {
      flags.push(`--user ${Math.floor(args.user)}`)
    }

    try {
      const output = await base.shell(
        deviceId,
        `pm install ${flags.join(' ')} "${remotePath}"`.replace(/\s+/g, ' ')
      )
      if (!/Success/i.test(output)) {
        throw new McpError(
          'INTERNAL',
          `pm install 失败：${output.trim() || '(无输出)'}${
            /INSTALL_FAILED_VERSION_DOWNGRADE/.test(output)
              ? '（版本更低，可传 downgrade:true 强制降级安装）'
              : ''
          }${
            /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/.test(
              output
            )
              ? '（签名不一致，需要先 aya_uninstall_app 再安装）'
              : ''
          }`
        )
      }
    } finally {
      if (pushed && tempPath) {
        await base.shell(deviceId, `rm -f "${tempPath}"`).catch(() => '')
      }
    }

    const settle = Math.max(Number(args.settle ?? 0), 0)
    if (settle > 0) {
      await afterInput(deviceId, settle)
    }

    return jsonResult({
      ok: true,
      deviceId,
      apkPath,
      devicePath: remotePath,
      pushed,
      flags,
      installed: true,
      settledMs: settle || null,
      hint: '如需启动，用 aya_start_app（需先知道包名，可用 aya_list_packages 按时间/关键字查找）',
    })
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
