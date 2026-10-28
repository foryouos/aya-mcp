import log from 'share/common/log'
import { getDeviceStore, setDeviceStore, shell } from './base'

const logger = log('adbPlatform')

// Android 与 Linux 工控主板（RK3568/RK3576 上的 Debian/Ubuntu/Buildroot/Yocto）
// 共用同一套 adb 传输，但设备端命令完全不同：Android 有 getprop/pm/am/logcat，
// Linux 只有 shell/sync，所以所有能力判断都走这里的结果，不再靠命令试错。
export type DevicePlatform = 'android' | 'linux'

export interface IPlatformCaps {
  getprop: boolean
  appProcess: boolean
  pm: boolean
  logcat: boolean
  journalctl: boolean
  dmesg: boolean
  systemd: boolean
  thermal: boolean
}

export interface IDevicePlatform {
  platform: DevicePlatform
  // 展示用名称：Android 13 / Ubuntu 22.04.5 LTS
  name: string
  // android / ubuntu / debian / buildroot / yocto / linux
  distro: string
  version: string
  arch: string
  kernel: string
  hostname: string
  root: boolean
  caps: IPlatformCaps
  at: number
}

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotSupportedError'
  }
}

// 设备可能被重新刷机，缓存不能永久有效；探测本身只有一次 adb shell 往返
const TTL = 5 * 60 * 1000
const CACHE_KEY = 'platform'

function unquote(val: string) {
  const str = val.trim()
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    return str.slice(1, -1)
  }

  return str
}

function parseOsRelease(text: string) {
  const ret: Record<string, string> = {}
  text.split('\n').forEach((line) => {
    const index = line.indexOf('=')
    if (index <= 0) {
      return
    }
    const key = line.slice(0, index).trim()
    if (!/^[A-Z_]+$/.test(key)) {
      return
    }
    ret[key] = unquote(line.slice(index + 1))
  })

  return ret
}

function buildName(os: Record<string, string>, kernel: string) {
  if (os.PRETTY_NAME) {
    return os.PRETTY_NAME
  }
  if (os.NAME && os.VERSION) {
    return `${os.NAME} ${os.VERSION}`
  }
  if (os.NAME) {
    return os.NAME
  }

  return `Linux ${kernel}`.trim()
}

async function probe(deviceId: string): Promise<IDevicePlatform> {
  const [
    sysName,
    arch,
    kernel,
    hostname,
    osRelease,
    uid,
    getprop,
    appProcess,
    pm,
    logcat,
    journalctl,
    dmesg,
    systemctl,
    thermal,
  ] = await shell(deviceId, [
    'uname -s',
    'uname -m',
    'uname -r',
    'hostname 2>/dev/null',
    'cat /etc/os-release 2>/dev/null',
    'id -u',
    'command -v getprop 2>/dev/null',
    'command -v app_process 2>/dev/null',
    'command -v pm 2>/dev/null',
    'command -v logcat 2>/dev/null',
    'command -v journalctl 2>/dev/null',
    'command -v dmesg 2>/dev/null',
    'command -v systemctl 2>/dev/null',
    'ls /sys/class/thermal 2>/dev/null',
  ])

  const os = parseOsRelease(osRelease)
  const isLinux = sysName === 'Linux'
  // Android 一定有 getprop（/system/bin/getprop），Linux 发行版没有；
  // 用 build 版本号二次确认，避免个别厂商在 Linux 上塞了同名脚本
  let sdk = ''
  let release = ''
  if (isLinux && getprop) {
    const [sdkOut, releaseOut] = await shell(deviceId, [
      'getprop ro.build.version.sdk 2>/dev/null',
      'getprop ro.build.version.release 2>/dev/null',
    ])
    sdk = sdkOut
    release = releaseOut
  }

  const android = isLinux && !!getprop && !!sdk
  const platform: DevicePlatform = android ? 'android' : 'linux'

  return {
    platform,
    name: android ? `Android ${release || sdk}`.trim() : buildName(os, kernel),
    distro: android
      ? 'android'
      : (os.ID || os.ID_LIKE || 'linux').toLowerCase(),
    version: android ? release || sdk : os.VERSION_ID || '',
    arch,
    kernel,
    hostname,
    root: uid === '0',
    caps: {
      getprop: !!getprop,
      appProcess: !!appProcess,
      pm: !!pm,
      logcat: !!logcat,
      journalctl: !!journalctl,
      dmesg: !!dmesg,
      systemd: !!systemctl,
      thermal: !!thermal,
    },
    at: Date.now(),
  }
}

/**
 * 探测并缓存设备平台。失败时退化到 android，保证 Android 设备行为不受影响。
 */
export async function getDevicePlatform(
  deviceId: string,
  force = false
): Promise<IDevicePlatform> {
  const cached: IDevicePlatform = getDeviceStore(deviceId, CACHE_KEY)
  if (!force && cached && Date.now() - cached.at < TTL) {
    return cached
  }

  try {
    const info = await probe(deviceId)
    setDeviceStore(deviceId, CACHE_KEY, info)
    logger.info(
      `platform ${deviceId}: ${info.platform} (${info.name} ${info.arch}, root=${info.root})`
    )

    return info
  } catch (err) {
    logger.error(
      `detect platform failed: ${deviceId} ${(err as Error).message}`
    )
    // 探测失败按 Android 处理：宁可让老路径继续跑，也不要凭空隐藏功能
    const fallback: IDevicePlatform = {
      platform: 'android',
      name: '',
      distro: 'android',
      version: '',
      arch: '',
      kernel: '',
      hostname: '',
      root: false,
      caps: {
        getprop: true,
        appProcess: true,
        pm: true,
        logcat: true,
        journalctl: false,
        dmesg: false,
        systemd: false,
        thermal: false,
      },
      at: Date.now(),
    }

    return fallback
  }
}

export function clearDevicePlatform(deviceId: string) {
  setDeviceStore(deviceId, CACHE_KEY, null)
}

/**
 * Android 专有能力（uiautomator / input / screencap / pm / am / logcat）的前置断言。
 * 直接抛错，让 IPC/MCP 立刻失败，而不是走到设备端报 "command not found"。
 */
export async function assertAndroid(
  deviceId: string,
  feature: string
): Promise<void> {
  const info = await getDevicePlatform(deviceId)
  if (info.platform !== 'android') {
    throw new NotSupportedError(
      `${feature} 依赖 Android 专有命令，当前设备是 ${info.name || 'Linux'}（${info.distro}），不支持该功能`
    )
  }
}
