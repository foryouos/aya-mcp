import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import {
  IAtraceResult,
  IpcCaptureAtrace,
  IpcCaptureServiceStack,
  IpcGetServiceBinder,
  IpcGetServiceDetail,
  IpcGetServiceProcess,
  IpcGetServices,
  IServiceBinderInfo,
  IServiceInfo,
  IServiceProcessInfo,
  ServiceKind,
} from 'common/types'
import { shell } from './base'
import { assertAndroid } from './platform'

const logger = log('adbServices')

let client: Client

// ============================================================================
// 解析层：纯函数，输入 adb 原始输出，输出结构化数据
// ============================================================================

// service list 每行：0	activity: [android.app.IActivityManager]
const SYSTEM_SERVICE_RE = /^(\d+)\s+(.+?):\s*\[(.*)\]$/
// lshal 每行末尾固定是「线程当前/线程上限  PID」。前面的列（DC,FM / Y / VINTF）
// 随版本变化，而且 HIDL 名字带 "::"、AIDL 名字只有 "."，不能写死其中一种格式。
const LSHAL_TAIL_RE = /(\d+)\/(\d+)\s+(\d+)\s*$/
// dumpsys activity services 记录头
const SERVICE_RECORD_RE =
  /^\*\s*ServiceRecord\{[0-9a-f]+\s+u\d+\s+([^/\s]+)\/([^\s}]+)\}/
const PROCESS_RECORD_RE = /app=ProcessRecord\{[0-9a-f]+\s+(\d+):/

// 常见的 Java 系统服务接口包前缀，用于把 system_server 里的服务区分出来
const JAVA_DESCRIPTOR_PREFIX = [
  'android.app.',
  'android.os.',
  'android.view.',
  'android.content.',
  'android.net.',
  'android.media.',
  'android.location.',
  'android.telephony.',
  'android.permission.',
  'android.accounts.',
  'android.database.',
  'android.security.',
  'android.service.',
  'android.sysprop.',
  'android.bluetooth.',
  'android.hardware.display.',
  'android.hardware.input.',
  'android.hardware.camera2.',
  'android.hardware.usb.',
  'android.hardware.sensors.',
  'android.hardware.vibrator.',
  'android.hardware.health.',
  'com.android.',
]

/** 哪些 descriptor 前缀可以确定其服务跑在 system_server 里 */
function isFrameworkDescriptor(descriptor: string): boolean {
  return JAVA_DESCRIPTOR_PREFIX.some((prefix) => descriptor.startsWith(prefix))
}

/**
 * 少数 native 服务的进程名和服务名不同（服务名是 binder 别名）。
 * 不做映射的话 pidof 永远失败，PID / 进程名 / RSS 全是空的。
 */
const NATIVE_PROCESS_ALIAS: { [key: string]: string } = {
  'media.audio_flinger': 'audioserver',
  'media.audio_policy': 'audioserver',
  'media.audio_effect': 'audioserver',
  'media.sound_trigger_hw': 'audioserver',
  'media.camera': 'cameraserver',
  'media.camera.proxy': 'cameraserver',
  'media.player': 'media',
  'media.extractor': 'media',
  'media.resource_manager': 'media',
  'media.drm': 'media',
  'media.metrics': 'media',
  'media.transcoding': 'media',
  'media.codec': 'media.swcodec',
}

/**
 * 这些 AIDL 服务的宿主进程名和接口名毫无关系，
 * 按命名惯例推断永远匹配不到，只能显式给出进程名。
 */
const AIDL_PROCESS_ALIAS: { [key: string]: string } = {
  'android.frameworks.cameraservice.service.ICameraService': 'cameraserver',
  'android.system.keystore2.IKeystoreService': 'keystore2',
  'android.system.net.netd.INetd': 'netd',
  'android.frameworks.stats.IStats': 'statsd',
  // 由系统进程直接登记的 AIDL
  'android.frameworks.sensorservice.ISensorManager': 'system_server',
  'android.hardware.usb.IUsb': 'system_server',
}

export interface IRawSystemService {
  index: number
  name: string
  descriptor: string
}

export interface IRawHal {
  interfaceName: string
  pid: number
  threadCurrent: number
  threadMax: number
}

export interface IRawProc {
  comm: string
  selinux: string
  uid: number
  gid: number
  rssKb: number
}

export function parseServiceList(output: string): IRawSystemService[] {
  const services: IRawSystemService[] = []

  output.split(/\r?\n/).forEach((raw) => {
    const matched = SYSTEM_SERVICE_RE.exec(raw.trim())
    if (!matched) {
      return
    }
    services.push({
      index: parseInt(matched[1], 10),
      name: matched[2].trim(),
      descriptor: matched[3].trim(),
    })
  })

  return services
}

export function parseLshal(output: string): IRawHal[] {
  const hals: IRawHal[] = []
  const seen = new Set<string>()

  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    // 段落标题以 ":" 结尾，表格行形如 "DC,FM Y xxx/yyy  0/4  523"
    if (!line || line.endsWith(':')) {
      return
    }
    const tail = LSHAL_TAIL_RE.exec(line)
    if (!tail) {
      return
    }
    // 名字是行尾数字前面的最后一个字段，HIDL 含 "::"、AIDL 只有 "."
    const head = line.slice(0, tail.index).trim()
    const name = head.split(/\s+/).pop() || ''
    if (!name.includes('.') || !/[A-Z]/.test(name) || seen.has(name)) {
      return
    }
    seen.add(name)
    hals.push({
      interfaceName: name,
      threadCurrent: parseInt(tail[1], 10),
      threadMax: parseInt(tail[2], 10),
      pid: parseInt(tail[3], 10),
    })
  })

  return hals
}

/**
 * 批量 /proc 采集结果。脚本输出形如：
 * @@691
 * u:r:system_server:s0
 * Uid:	1000	1000	1000	1000
 * ...
 *
 * 注意这里不再解析 comm：/proc/<pid>/comm 读的是主线程名，
 * 对其它 SELinux domain 的进程会被拒绝（返回空），
 * 而 HAL 进程的主线程常被改名为 binder:523_2，含冒号会让解析错位。
 * 进程名统一由 ps -A -o PID,NAME 提供。
 */
export function parseProcBatch(output: string): Map<number, IRawProc> {
  const result = new Map<number, IRawProc>()
  let pid = 0
  let selinux = ''
  let uid = 0
  let gid = 0
  let rssKb = 0

  const flush = () => {
    if (pid > 0) {
      result.set(pid, { comm: '', selinux, uid, gid, rssKb })
    }
  }

  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()

    if (line.startsWith('@@')) {
      flush()
      pid = parseInt(line.slice(2), 10) || 0
      selinux = ''
      uid = 0
      gid = 0
      rssKb = 0
      return
    }

    if (!pid || !line) {
      return
    }

    if (line.startsWith('u:r:') || line.startsWith('u:object_r:')) {
      selinux = line
      return
    }
    if (line.startsWith('Uid:')) {
      const parts = line.split(/\s+/)
      uid = parseInt(parts[1], 10) || 0
      return
    }
    if (line.startsWith('Gid:')) {
      const parts = line.split(/\s+/)
      gid = parseInt(parts[1], 10) || 0
      return
    }
    if (line.startsWith('VmRSS:')) {
      rssKb = parseInt(line.replace(/[^\d]/g, ''), 10) || 0
    }
  })
  flush()

  return result
}

/**
 * 解析 ps -A -o PID,NAME。ps 读的是内核里的 comm，
 * 不受 /proc/<pid>/comm 的 SELinux 限制，是进程名最可靠的来源。
 */
export function parsePsNames(output: string): Map<number, string> {
  const names = new Map<number, string>()

  output.split(/\r?\n/).forEach((raw) => {
    const matched = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(raw)
    if (!matched) {
      return
    }
    const pid = parseInt(matched[1], 10)
    const name = matched[2].trim()
    if (pid > 0 && name) {
      names.set(pid, name)
    }
  })

  return names
}

/** 解析 ps -A -o PID,ARGS，用于按 cmdline 推断 AIDL HAL 的宿主进程 */
export function parsePsArgs(output: string): Array<{ pid: number; args: string }> {
  const rows: Array<{ pid: number; args: string }> = []

  output.split(/\r?\n/).forEach((raw) => {
    const matched = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(raw)
    if (!matched) {
      return
    }
    const pid = parseInt(matched[1], 10)
    if (pid > 0) {
      rows.push({ pid, args: matched[2].trim() })
    }
  })

  return rows
}

export function parseAppServiceRecords(
  output: string
): Array<{ packageName: string; className: string; pid: number }> {
  const services: Array<{ packageName: string; className: string; pid: number }> =
    []
  let current: {
    packageName: string
    className: string
    pid: number
  } | null = null

  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()

    const record = SERVICE_RECORD_RE.exec(line)
    if (record) {
      if (current) {
        services.push(current)
      }
      const packageName = record[1]
      let className = record[2]
      if (className.startsWith('.')) {
        className = packageName + className
      }
      current = { packageName, className, pid: 0 }
      return
    }

    if (!current) {
      return
    }
    const process = PROCESS_RECORD_RE.exec(line)
    if (process) {
      current.pid = parseInt(process[1], 10)
    }
  })
  if (current) {
    services.push(current)
  }

  return services
}

/** 按名称与接口描述符推断服务类型 */
export function classifyService(name: string, descriptor: string): ServiceKind {
  // servicemanager 里带实例后缀（xxx.IFoo/default）的才是 AIDL HAL，
  // 不限于 android.hardware.*，android.frameworks.* / vendor.* 同理。
  // 注意 display / input / lights 这些 Java 服务的 descriptor 也是
  // android.hardware.xxx.IFoo，但注册名没有实例后缀，不能算 HAL。
  if (name.includes('/') && /\.[A-Z]/.test(name)) {
    return 'aidl-hal'
  }
  if (name.includes('::')) {
    return 'hidl-hal'
  }
  if (descriptor && descriptor.includes('::')) {
    return 'hidl-hal'
  }
  // 只认明确的 framework 前缀：裸的 android.hardware.ICameraService
  // 属于 cameraserver 而不是 system_server，不能被兜底
  if (isFrameworkDescriptor(descriptor)) {
    return 'java-system'
  }

  return 'native-binder'
}

export function isVendorService(
  name: string,
  descriptor: string,
  processName: string
): boolean {
  const text = `${name} ${descriptor} ${processName}`.toLowerCase()

  return (
    text.includes('vendor.') ||
    text.includes('/vendor/') ||
    text.includes('rockchip.') ||
    text.includes('odm.')
  )
}

function normalizeHex(text: string): number {
  const value = parseInt(String(text || '').replace(/\s/g, ''), 10)

  return Number.isFinite(value) ? value : 0
}

// ============================================================================
// 采集层：负责执行 adb 命令
// ============================================================================

/**
 * 一次性批量读取多个 pid 的 comm / selinux / uid / gid / rss。
 * 逐个 pid 发一条 shell 在 200+ 服务下会非常慢，这里合并成一条脚本。
 */
export async function collectProcBatch(
  deviceId: string,
  pids: number[]
): Promise<Map<number, IRawProc>> {
  const unique = Array.from(new Set(pids.filter((pid) => pid > 0)))
  if (!unique.length) {
    return new Map()
  }

  // attr/current 末尾没有换行，必须补 echo，否则会和下一段 Uid 粘连
  const script = unique
    .map(
      (pid) =>
        `echo "@@${pid}"; cat /proc/${pid}/attr/current 2>/dev/null; echo; grep -E '^(Uid|Gid|VmRSS)' /proc/${pid}/status 2>/dev/null`
    )
    .join('; ')

  // 进程名单独用 ps 取：/proc/<pid>/comm 对别的 SELinux domain 会被拒绝
  const [procOut, psOut] = await Promise.all([
    shell(deviceId, script, 30000).catch((err) => {
      logger.warn('collect proc batch failed', err)
      return ''
    }),
    shell(deviceId, 'ps -A -o PID,NAME', 20000).catch(() => ''),
  ])

  const result = parseProcBatch(procOut)
  const wanted = new Set(unique)
  parsePsNames(psOut).forEach((name, pid) => {
    if (!wanted.has(pid)) {
      return
    }
    const proc = result.get(pid)
    if (proc) {
      proc.comm = name
    } else {
      result.set(pid, { comm: name, selinux: '', uid: 0, gid: 0, rssKb: 0 })
    }
  })

  return result
}

/**
 * AIDL HAL 通过 servicemanager 注册，Android 没有提供非 root 的
 * 「服务 → 宿主进程」查询接口（lshal 只管 HIDL，dumpsys 也不带 PID）。
 * 这里按 HAL 进程的命名惯例做唯一命中推断：进程 cmdline 里含接口包名。
 * 有歧义时宁可不填，避免给出错误的 PID。
 */
export function guessHalPid(
  serviceName: string,
  procs: Array<{ pid: number; args: string }>
): number {
  const [base, ...rest] = serviceName.split('/')
  const instance = rest.join('/')
  // 去掉末尾的接口名：android.hardware.gnss.IGnss → android.hardware.gnss
  const withoutInterface = base.replace(/\.I[A-Z]\w*$/, '')
  const segments = withoutInterface.split('.')
  if (segments.length < 3) {
    return 0
  }

  for (let len = segments.length; len >= 3; len--) {
    const prefix = segments.slice(0, len).join('.')
    const candidates = procs.filter((proc) => proc.args.includes(prefix))
    if (candidates.length === 1) {
      return candidates[0].pid
    }
    if (candidates.length > 1) {
      // 多实例设备（drm 的 clearkey/widevine、相机的 external/internal）
      // 用实例名的第一段区分，实例后缀里的 "/0" 不会出现在进程名里
      const instanceKey = (instance || '').split('/')[0]
      if (instanceKey && instanceKey !== 'default') {
        const refined = candidates.filter((proc) =>
          proc.args.includes(instanceKey)
        )
        if (refined.length === 1) {
          return refined[0].pid
        }
      }

      return 0
    }
  }

  return 0
}

async function collectSystemServices(deviceId: string) {
  const [listOut, lshalOut, ssPidOut] = await Promise.all([
    shell(deviceId, 'service list', 30000).catch(() => ''),
    shell(deviceId, 'lshal 2>/dev/null', 40000).catch(() => ''),
    shell(deviceId, 'pidof system_server', 10000).catch(() => ''),
  ])

  return {
    services: parseServiceList(listOut),
    hals: parseLshal(lshalOut),
    systemServerPid: parseInt(ssPidOut.trim().split(/\s+/)[0] || '0', 10) || 0,
  }
}

/**
 * 采集全部服务：servicemanager（service list）+ hwservicemanager（lshal）+
 * 应用 Service（dumpsys activity services），最后批量补齐 /proc 信息。
 */
export async function collectServices(deviceId: string): Promise<IServiceInfo[]> {
  await assertAndroid(deviceId, '服务列表（service list / lshal）')

  const [{ services, hals, systemServerPid }, appOut] = await Promise.all([
    collectSystemServices(deviceId),
    shell(deviceId, 'dumpsys activity services', 60000).catch(() => ''),
  ])
  const appServices = parseAppServiceRecords(appOut)

  const rows: IServiceInfo[] = []
  const seen = new Set<string>()

  const pushRow = (row: IServiceInfo) => {
    if (seen.has(row.id)) {
      return
    }
    seen.add(row.id)
    rows.push(row)
  }

  const halByName = new Map<string, IRawHal>()
  hals.forEach((hal) => halByName.set(hal.interfaceName, hal))

  services.forEach((service) => {
    const kind = classifyService(service.name, service.descriptor)
    const hal = halByName.get(service.name)
    let pid = 0
    if (hal) {
      pid = hal.pid
    } else if (kind === 'java-system' && isFrameworkDescriptor(service.descriptor)) {
      // Java 系统服务跑在 system_server 里；
      // 但裸的 android.hardware.ICameraService（media.camera）属于 cameraserver，
      // 不能一并塞成 system_server 的 PID
      pid = systemServerPid
    }

    pushRow({
      id: `system:${service.name}`,
      origin: 'system',
      name: service.name,
      descriptor: service.descriptor,
      packageName: '',
      className: '',
      pid,
      processName: '',
      kind,
      selinux: '',
      status: 'unknown',
      uid: 0,
      gid: 0,
      rssKb: 0,
      threadCurrent: hal ? hal.threadCurrent : 0,
      threadMax: hal ? hal.threadMax : 0,
      vendor: isVendorService(service.name, service.descriptor, ''),
      runningMs: 0,
      startRequested: false,
      foreground: false,
      bindings: 0,
    })
  })

  // lshal 里有、但 service list 里没有的 HIDL HAL
  hals.forEach((hal) => {
    pushRow({
      id: `system:${hal.interfaceName}`,
      origin: 'system',
      name: hal.interfaceName,
      descriptor: hal.interfaceName.split('/')[0],
      packageName: '',
      className: '',
      pid: hal.pid,
      processName: '',
      kind: 'hidl-hal',
      selinux: '',
      status: hal.pid > 0 ? 'running' : 'lazy',
      uid: 0,
      gid: 0,
      rssKb: 0,
      threadCurrent: hal.threadCurrent,
      threadMax: hal.threadMax,
      vendor: isVendorService(hal.interfaceName, '', ''),
      runningMs: 0,
      startRequested: false,
      foreground: false,
      bindings: 0,
    })
  })

  appServices.forEach((service) => {
    pushRow({
      id: `app:${service.packageName}/${service.className}`,
      origin: 'app',
      name: service.className,
      descriptor: '',
      packageName: service.packageName,
      className: service.className,
      pid: service.pid,
      processName: service.packageName,
      kind: 'app-service',
      selinux: '',
      status: service.pid > 0 ? 'running' : 'unknown',
      uid: 0,
      gid: 0,
      rssKb: 0,
      threadCurrent: 0,
      threadMax: 0,
      vendor: isVendorService(service.packageName, '', ''),
      runningMs: 0,
      startRequested: false,
      foreground: false,
      bindings: 0,
    })
  })

  // Native 服务（SurfaceFlinger / installd 等）在 service list 里没有 PID，
  // 用「服务名小写 == 进程名」的经验规则批量 pidof 一次
  await resolveNativePids(deviceId, rows)

  // AIDL HAL 没有 PID 来源，按进程命名惯例做唯一命中推断
  await resolveAidlPids(deviceId, rows)

  // 批量补齐进程信息
  const procMap = await collectProcBatch(
    deviceId,
    rows.map((row) => row.pid)
  )
  rows.forEach((row) => {
    const proc = procMap.get(row.pid)
    if (!proc) {
      if (row.kind !== 'aidl-hal' && row.pid === 0) {
        row.status = row.status === 'lazy' ? 'lazy' : 'unknown'
      }
      return
    }
    row.processName = proc.comm
    row.selinux = proc.selinux
    row.uid = proc.uid
    row.gid = proc.gid
    row.rssKb = proc.rssKb
    row.status = 'running'
    if (!row.vendor) {
      row.vendor = isVendorService(row.name, row.descriptor, proc.comm)
    }
  })

  logger.info(
    `services total=${rows.length} hidl=${hals.length} withPid=${
      rows.filter((row) => row.pid > 0).length
    }`
  )

  return rows
}

async function resolveNativePids(deviceId: string, rows: IServiceInfo[]) {
  const targets = rows
    .filter(
      (row) =>
        row.pid === 0 &&
        row.kind === 'native-binder' &&
        /^[A-Za-z][A-Za-z0-9_.-]*$/.test(row.name)
    )
    .slice(0, 120)
  if (!targets.length) {
    return
  }

  const script = targets
    .map((row) => {
      // 只查服务名对应的进程名，查不到就留空，不做任何猜测
      const processName =
        NATIVE_PROCESS_ALIAS[row.name] || row.name.toLowerCase()

      return `echo "${row.id}=$(pidof ${processName} 2>/dev/null | cut -d' ' -f1)"`
    })
    .join('; ')

  try {
    const output = await shell(deviceId, script, 20000)
    const resolved = new Map<string, number>()
    output.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim()
      const index = line.lastIndexOf('=')
      if (index <= 0) {
        return
      }
      const id = line.slice(0, index)
      const pid = parseInt(line.slice(index + 1), 10)
      if (pid > 0) {
        resolved.set(id, pid)
      }
    })
    rows.forEach((row) => {
      const pid = resolved.get(row.id)
      if (pid) {
        row.pid = pid
      }
    })
  } catch (err) {
    logger.warn('resolve native pid failed', err)
  }
}

/**
 * AIDL HAL 补 PID。ps -A -o PID,ARGS 只跑一次，
 * 所有待推断的服务共用这份进程表。
 */
async function resolveAidlPids(deviceId: string, rows: IServiceInfo[]) {
  const targets = rows.filter((row) => row.pid === 0 && row.kind === 'aidl-hal')
  if (!targets.length) {
    return
  }

  // 已知别名的进程先批量 pidof 一次
  const aliasPids = new Map<string, number>()
  const aliasNames = Array.from(
    new Set(
      targets
        .map((row) => AIDL_PROCESS_ALIAS[row.name.split('/')[0]])
        .filter(Boolean)
    )
  )
  if (aliasNames.length) {
    try {
      const script = aliasNames
        .map(
          (name) =>
            `echo "${name}=$(pidof ${name} 2>/dev/null | cut -d' ' -f1)"`
        )
        .join('; ')
      const output = await shell(deviceId, script, 15000)
      output.split(/\r?\n/).forEach((raw) => {
        const line = raw.trim()
        const index = line.lastIndexOf('=')
        if (index <= 0) {
          return
        }
        const pid = parseInt(line.slice(index + 1), 10)
        if (pid > 0) {
          aliasPids.set(line.slice(0, index), pid)
        }
      })
    } catch (err) {
      logger.warn('resolve aidl alias pid failed', err)
    }
  }

  try {
    const output = await shell(deviceId, 'ps -A -o PID,ARGS', 20000)
    const procs = parsePsArgs(output)
    targets.forEach((row) => {
      const alias = AIDL_PROCESS_ALIAS[row.name.split('/')[0]]
      const aliasPid = alias ? aliasPids.get(alias) : 0
      if (aliasPid) {
        row.pid = aliasPid
        return
      }
      const pid = guessHalPid(row.name, procs)
      if (pid) {
        row.pid = pid
      }
    })
  } catch (err) {
    logger.warn('resolve aidl pid failed', err)
  }
}

/** 单条服务的 dumpsys 输出（可带参数） */
export async function collectServiceDumpsys(
  deviceId: string,
  kind: 'system' | 'app',
  target: string,
  args = ''
): Promise<string> {
  await assertAndroid(deviceId, '服务详情（dumpsys）')
  const name = String(target || '').trim()
  if (!/^[A-Za-z0-9_./@:$-]+$/.test(name)) {
    throw new Error(`非法的服务标识：${name}`)
  }
  const extra = String(args || '')
    .trim()
    .slice(0, 200)
  if (extra && !/^[A-Za-z0-9_./:=@\-\s]+$/.test(extra)) {
    throw new Error(`非法的 dumpsys 参数：${extra}`)
  }

  const cmd =
    kind === 'app'
      ? `dumpsys activity service ${name}${extra ? ` ${extra}` : ''}`
      : `dumpsys ${name}${extra ? ` ${extra}` : ''}`

  return shell(deviceId, cmd, 60000)
}

/** 进程与硬件环境：init rc、fd 节点、uid/gid/rss */
export async function collectServiceProcess(
  deviceId: string,
  pid: number,
  processName: string
): Promise<IServiceProcessInfo> {
  await assertAndroid(deviceId, '服务进程信息')
  const safePid = Math.max(0, Math.floor(Number(pid) || 0))
  const comm = String(processName || '').trim()

  const result: IServiceProcessInfo = {
    pid: safePid,
    comm: '',
    cmdline: '',
    selinux: '',
    uid: 0,
    gid: 0,
    rssKb: 0,
    initRc: [],
    fds: [],
    fdDenied: false,
  }

  if (!safePid) {
    return result
  }

  const script = [
    `echo "@@comm"; cat /proc/${safePid}/comm 2>/dev/null`,
    `echo "@@cmdline"; cat /proc/${safePid}/cmdline 2>/dev/null | tr '\\0' ' '; echo`,
    `echo "@@selinux"; cat /proc/${safePid}/attr/current 2>/dev/null; echo`,
    `echo "@@status"; grep -E '^(Uid|Gid|VmRSS)' /proc/${safePid}/status 2>/dev/null`,
    `echo "@@fd"; ls -l /proc/${safePid}/fd 2>&1 | head -200`,
    `echo "@@fdend"`,
  ].join('; ')

  const output = await shell(deviceId, script, 30000)
  const sections = new Map<string, string[]>()
  let current = ''
  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    if (line.startsWith('@@')) {
      current = line.slice(2)
      sections.set(current, [])
      return
    }
    if (current && sections.has(current)) {
      sections.get(current)!.push(line)
    }
  })

  result.comm = (sections.get('comm') || []).join('').trim()
  result.cmdline = (sections.get('cmdline') || []).join('').trim()
  // attr/current 的读取结果末尾可能带 NUL
  result.selinux = (sections.get('selinux') || [])
    .join('')
    .replace(/\0/g, '')
    .trim()

  const statusLines = sections.get('status') || []
  statusLines.forEach((line) => {
    if (line.startsWith('Uid:')) {
      result.uid = parseInt(line.split(/\s+/)[1], 10) || 0
    } else if (line.startsWith('Gid:')) {
      result.gid = parseInt(line.split(/\s+/)[1], 10) || 0
    } else if (line.startsWith('VmRSS:')) {
      result.rssKb = parseInt(line.replace(/[^\d]/g, ''), 10) || 0
    }
  })

  const fds = sections.get('fd') || []
  if (fds.some((line) => line.toLowerCase().includes('permission denied'))) {
    result.fdDenied = true
  } else {
    result.fds = fds
      .map((line) => {
        const index = line.indexOf(' -> ')
        return index >= 0 ? line.slice(index + 4).trim() : ''
      })
      .filter((target) => target.startsWith('/dev/') || target.startsWith('/sys/'))
      .slice(0, 100)
  }

  // init rc：用进程名在常见目录里反查
  const keyword = (result.comm || comm).replace(/[^\w.-]/g, '')
  if (keyword) {
    try {
      const rcOut = await shell(
        deviceId,
        `grep -l "service .*${keyword}" /vendor/etc/init/*.rc /odm/etc/init/*.rc /system/etc/init/*.rc 2>/dev/null | head -10`,
        20000
      )
      result.initRc = rcOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      result.initRc = []
    }
  }

  return result
}

/** Binder 拓扑：从 debugfs 解析线程与引用 */
export async function collectServiceBinder(
  deviceId: string,
  pid: number
): Promise<IServiceBinderInfo> {
  const safePid = Math.max(0, Math.floor(Number(pid) || 0))
  const result: IServiceBinderInfo = {
    pid: safePid,
    available: false,
    error: '',
    context: '',
    threads: 0,
    maxThreads: 0,
    refs: [],
    nodes: 0,
  }

  if (!safePid) {
    result.error = '该服务没有可用的 PID'

    return result
  }

  let output = ''
  try {
    output = await shell(
      deviceId,
      `cat /d/binder/proc/${safePid} 2>&1 | head -400`,
      20000
    )
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)

    return result
  }

  if (
    /permission denied|no such file|not found/i.test(output) ||
    !output.includes('binder')
  ) {
    result.error = output.trim().slice(0, 200) || '无法访问 /d/binder/proc'

    return result
  }

  const refs = new Set<number>()
  let threads = 0
  let nodes = 0

  output.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    if (line.startsWith('context ')) {
      result.context = line.slice('context '.length).trim()
    } else if (line.startsWith('thread ')) {
      threads++
    } else if (line.startsWith('node ')) {
      nodes++
    } else if (line.startsWith('ref ')) {
      const matched = /^ref\s+(\d+):/.exec(line)
      if (matched) {
        refs.add(parseInt(matched[1], 10))
      }
    }
  })

  result.available = true
  result.threads = threads
  result.nodes = nodes
  result.refs = Array.from(refs).sort((a, b) => a - b).slice(0, 50)

  return result
}

/** Native 栈回溯（需要 root） */
export async function captureServiceStack(
  deviceId: string,
  pid: number
): Promise<{ ok: boolean; output: string; error: string }> {
  await assertAndroid(deviceId, 'Native 栈回溯（debuggerd）')
  const safePid = Math.max(0, Math.floor(Number(pid) || 0))
  if (!safePid) {
    return { ok: false, output: '', error: '该服务没有可用的 PID' }
  }

  try {
    const output = await shell(deviceId, `debuggerd -b ${safePid} 2>&1`, 30000)
    if (/root is required|permission denied/i.test(output)) {
      return {
        ok: false,
        output,
        error: 'debuggerd 需要 root 权限，当前 shell 用户无法抓取',
      }
    }

    return { ok: true, output, error: '' }
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 抓取 atrace 并保存到本地临时文件 */
export async function captureAtrace(
  deviceId: string,
  seconds: number
): Promise<IAtraceResult> {
  await assertAndroid(deviceId, 'atrace')
  const duration = Math.min(Math.max(Math.floor(Number(seconds) || 3), 1), 30)
  const remote = `/data/local/tmp/aya-trace-${Date.now()}.txt`

  const output = await shell(
    deviceId,
    `atrace -t ${duration} -b 8192 -a '*' gfx view wm am res input binder_driver > ${remote} 2>/dev/null; cat ${remote}; rm -f ${remote}`,
    (duration + 20) * 1000
  )
  const localPath = path.join(os.tmpdir(), `aya-trace-${Date.now()}.txt`)
  await fs.writeFile(localPath, output)

  return { path: localPath, bytes: Buffer.byteLength(output) }
}

// ============================================================================
// IPC 注册
// ============================================================================

const getServices: IpcGetServices = async function (deviceId) {
  return collectServices(deviceId)
}

const getServiceDetail: IpcGetServiceDetail = async function (
  deviceId,
  kind,
  target,
  args
) {
  const output = await collectServiceDumpsys(deviceId, kind, target, args)

  return { kind, target, output }
}

const getServiceProcess: IpcGetServiceProcess = async function (
  deviceId,
  pid,
  processName
) {
  return collectServiceProcess(deviceId, pid, processName)
}

const getServiceBinder: IpcGetServiceBinder = async function (deviceId, pid) {
  return collectServiceBinder(deviceId, pid)
}

const captureStack: IpcCaptureServiceStack = async function (deviceId, pid) {
  return captureServiceStack(deviceId, pid)
}

const atrace: IpcCaptureAtrace = async function (deviceId, seconds) {
  return captureAtrace(deviceId, seconds)
}

export async function init(c: Client) {
  client = c
  void client

  handleEvent('getServices', getServices)
  handleEvent('getServiceDetail', getServiceDetail)
  handleEvent('getServiceProcess', getServiceProcess)
  handleEvent('getServiceBinder', getServiceBinder)
  handleEvent('captureServiceStack', captureStack)
  handleEvent('captureAtrace', atrace)
}

export { normalizeHex }
