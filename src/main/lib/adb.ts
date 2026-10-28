import { app } from 'electron'
import Adb, { Client, Device } from '@devicefarmer/adbkit'
import androidDeviceList from 'android-device-list'
import {
  resolveResources,
  handleEvent,
  getUserDataPath,
} from 'share/main/lib/util'
import map from 'licia/map'
import types from 'licia/types'
import filter from 'licia/filter'
import isStrBlank from 'licia/isStrBlank'
import trim from 'licia/trim'
import startWith from 'licia/startWith'
import toNum from 'licia/toNum'
import contain from 'licia/contain'
import * as window from 'share/main/lib/window'
import fs from 'fs-extra'
import { getSettingsStore } from './store'
import isWindows from 'licia/isWindows'
import isEmpty from 'licia/isEmpty'
import * as base from './adb/base'
import { shell, getAdbPath, spawnAdb, isRooted } from './adb/base'
import {
  getDevicePlatform,
  assertAndroid,
  IDevicePlatform,
} from './adb/platform'
import * as logcat from './adb/logcat'
import * as shellAdb from './adb/shell'
import * as server from './adb/server'
import * as scrcpy from './adb/scrcpy'
import * as packageAdb from './adb/package'
import * as file from './adb/file'
import * as fps from './adb/fps'
import * as webview from './adb/webview'
import * as port from './adb/port'
import { getCpuLoads, getCpus, getCpuTemperature } from './adb/cpu'
import log from 'share/common/log'
import {
  IDevice,
  IpcConnectDevice,
  IpcDisconnectDevice,
  IpcDumpWindowHierarchy,
  IpcGetDevices,
  IpcInputKey,
  IpcInputSwipe,
  IpcInputTap,
  IpcInputText,
  IpcPairDevice,
  IpcScreencap,
} from 'common/types'
import path from 'node:path'
import childProcess from 'node:child_process'
import isMac from 'licia/isMac'
import sleep from 'licia/sleep'

const logger = log('adb')

const settingsStore = getSettingsStore()

let client: Client

export const getDevices: IpcGetDevices = async function () {
  let devices: Device[]
  try {
    devices = await client.listDevices()
  } catch (e) {
    // adb server 可能尚未就绪（冷启动），等待后重试一次
    logger.warn('list devices failed, retry', e)
    await sleep(1000)
    devices = await client.listDevices()
  }
  devices = filter(
    devices,
    (device: Device) => device.type === 'emulator' || device.type === 'device'
  )

  // 每台设备独立降级：以前用 Promise.all(...).catch(() => []) 兜底，
  // 只要有一台设备读属性失败，整个设备列表都会变空
  return Promise.all(
    map(devices, async (device: Device): Promise<IDevice> => {
      const info: IDevice = {
        id: device.id,
        type: device.type,
        serialno: '',
        name: device.id,
        androidVersion: '',
        sdkVersion: '',
        platform: 'android',
        distro: '',
        arch: '',
      }

      try {
        const platform = await getDevicePlatform(device.id)
        info.platform = platform.platform
        info.distro = platform.distro
        info.arch = platform.arch

        if (platform.platform === 'linux') {
          // Linux 主板没有 getprop：名称/序列号改用发行版信息与主机名
          info.name = platform.name || device.id
          info.serialno = platform.hostname || ''
          return info
        }

        const properties = await client.getDevice(device.id).getProperties()
        let name = `${properties['ro.product.manufacturer']} ${properties['ro.product.model']}`
        const marketName = getMarketName(properties)
        if (marketName) {
          name = marketName
        }

        info.name = name
        info.serialno = properties['ro.serialno'] || ''
        info.androidVersion = properties['ro.build.version.release'] || ''
        info.sdkVersion = properties['ro.build.version.sdk'] || ''
      } catch (err) {
        logger.warn(
          `read device info failed: ${device.id} ${(err as Error).message}`
        )
      }

      return info
    })
  )
}

export async function getOverview(deviceId: string) {
  const platform = await getDevicePlatform(deviceId)
  if (platform.platform === 'linux') {
    return getLinuxOverview(deviceId, platform)
  }

  const device = await client.getDevice(deviceId)
  const properties = await device.getProperties()
  const cpus = await getCpus(deviceId, false)
  const [kernelVersion, fontScale, wifi] = await shell(deviceId, [
    'uname -r',
    'settings get system font_scale',
    'dumpsys wifi',
  ])

  let ssidMatch = wifi.match(/mWifiInfo\s+SSID: "?(.+?)"?,/)
  if (ssidMatch && ssidMatch[1] === '<unknown ssid>') {
    ssidMatch = null
  }

  return {
    name: getMarketName(properties) || properties['ro.product.name'],
    processor: properties['ro.product.board'] || '',
    abi: properties['ro.product.cpu.abi'],
    brand: properties['ro.product.brand'],
    model: properties['ro.product.model'],
    serialno: properties['ro.serialno'] || '',
    cpuNum: cpus.length,
    kernelVersion,
    fontScale: fontScale === 'null' ? 0 : toNum(fontScale),
    wifi: ssidMatch ? ssidMatch[1] : '',
    root: await isRooted(deviceId),
    ...(await getIpAndMac(deviceId)),
    ...(await getStorage(deviceId)),
    ...(await getMemory(deviceId)),
    ...(await getScreen(deviceId)),
  }
}

// ip -o 的输出会用一个反斜杠 + 换行折行（link 信息另起一行），拍平后再解析
function flattenIpOutput(out: string) {
  return out.replace(/\\\s*\n/g, ' ')
}

/**
 * 从 `ip route/link/addr` 的输出里挑出真正在用的网卡。
 * 以前只看 `ip -o addr show scope global`，DHCP 还没拿到地址时整段为空，
 * MAC 也跟着丢了；这里改成按默认路由 + operstate 选网卡，MAC 与 IP 分开取。
 */
function parseLinuxNet(defaultRoute: string, linkOut: string, addrOut: string) {
  const ifaces: { name: string; mac: string; up: boolean }[] = []
  flattenIpOutput(linkOut)
    .split('\n')
    .forEach((line) => {
      const name = line.match(/^\d+:\s+([^\s:@]+)/)
      if (!name) {
        return
      }
      const mac = line.match(/link\/ether\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)
      ifaces.push({
        name: name[1],
        mac: mac ? mac[1].toLowerCase() : '',
        up: /state\s+UP/.test(line),
      })
    })

  const dev = defaultRoute.match(/default\s+.*\bdev\s+(\S+)/)
  const candidates = ifaces.filter((item) => item.mac && item.name !== 'lo')
  const primary =
    (dev && candidates.find((item) => item.name === dev[1])) ||
    candidates.find((item) => item.up) ||
    candidates[0]

  if (!primary) {
    return { ifname: '', mac: '', ip: '' }
  }

  const prefix = new RegExp(`^\\d+:\\s+${primary.name}\\s`)
  const lines = flattenIpOutput(addrOut)
    .split('\n')
    .filter((line) => prefix.test(line))
  const pick = (re: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(re)
      if (match) {
        return match[1]
      }
    }
    return ''
  }
  // 优先 IPv4，其次全局 IPv6，最后链路本地 IPv6
  const ip =
    pick(/inet\s+(\d+\.\d+\.\d+\.\d+)/) ||
    pick(/inet6\s+([0-9a-f:]+)\/\d+\s+scope\s+global/i) ||
    pick(/inet6\s+([0-9a-f:]+)/i)

  return { ifname: primary.name, mac: primary.mac, ip }
}

// Linux 工控主板没有 getprop / dumpsys / wm，概览信息全部从 /proc、/sys、ip、df 读
async function getLinuxOverview(deviceId: string, platform: IDevicePlatform) {
  const cpus = await getCpus(deviceId, false)
  const [
    boardModel,
    compatible,
    defaultRoute,
    linkOut,
    addrOut,
    dfOut,
    modes,
    kernelVersion,
  ] = await shell(deviceId, [
    'cat /proc/device-tree/model 2>/dev/null',
    'cat /proc/device-tree/compatible 2>/dev/null',
    'ip route show default 2>/dev/null',
    'ip -o link show 2>/dev/null',
    'ip -o addr show 2>/dev/null',
    'df -k / 2>/dev/null',
    'for f in /sys/class/drm/card*-*/modes; do head -1 $f 2>/dev/null; done',
    'uname -r',
  ])

  // device-tree 的字符串没有换行，末尾可能残留 \0
  const model = trim(boardModel).replace(/\0/g, '')
  // "rockchip,rk3568" -> RK3568
  const soc = (compatible.split(',')[1] || '').split('\0')[0].toUpperCase()
  const net = parseLinuxNet(defaultRoute, linkOut, addrOut)
  const dfLine = trim(dfOut.split('\n').pop() || '').split(/\s+/)
  const resolution = trim(modes.split('\n')[0] || '')

  return {
    name: model || platform.name,
    processor: soc || platform.arch,
    abi: platform.arch,
    brand: platform.distro,
    model: model || platform.name,
    serialno: platform.hostname,
    cpuNum: cpus.length,
    kernelVersion,
    fontScale: 0,
    wifi: '',
    root: platform.root,
    // Linux 上没有 Wi-Fi 概念，用网卡名代替，避免概览里显示「未知」
    networkInterface: net.ifname,
    ip: net.ip,
    mac: net.mac,
    storageTotal: toNum(dfLine[1]) * 1024,
    storageUsed: toNum(dfLine[2]) * 1024,
    ...(await getMemory(deviceId)),
    resolution,
    physicalResolution: resolution,
    density: 0,
    physicalDensity: 0,
  }
}

async function getIpAndMac(deviceId: string) {
  let ip = ''
  let mac = ''
  const wlan0 = await shell(deviceId, 'ip addr show wlan0')
  const ipMatch = wlan0.match(/inet (\d+\.\d+\.\d+\.\d+)/)
  if (ipMatch) {
    ip = ipMatch[1]
  }
  const macMatch = wlan0.match(
    /link\/ether (([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2}))/
  )
  if (macMatch) {
    mac = macMatch[1]
  }

  return {
    ip,
    mac,
  }
}

export async function setFontScale(deviceId: string, scale: number) {
  await assertAndroid(deviceId, '字体缩放（settings put）')
  await shell(deviceId, `settings put system font_scale ${scale}`)
}

function getMarketName(properties: types.PlainObj<string>) {
  const keys = [
    // Oppo
    'ro.oppo.market.name',
    // Huawei, Honor
    'ro.config.marketing_name',
    // OnePlus, Realme
    'ro.vendor.oplus.market.enname',
    // Vivo
    'ro.vivo.market.name',
    // Xiaomi, Redmi
    'ro.product.marketname',
    // Asus
    'ro.asus.product.mkt_name',
  ]
  for (let i = 0, len = keys.length; i < len; i++) {
    const key = keys[i]
    if (properties[key]) {
      return properties[key]
    }
  }

  const device = properties['ro.product.device']
  const model = properties['ro.product.model']

  // Linux 主板没有 getprop，两个字段都是 undefined；
  // android-device-list 对非字符串入参会直接抛 TypeError
  if (!device) {
    return ''
  }

  let marketName = ''

  const devices: any[] = androidDeviceList.getDevicesByDeviceId(device)
  if (!isEmpty(devices)) {
    const deviceFilter = filter(devices, (device) => device.model === model)
    if (!isEmpty(deviceFilter)) {
      marketName = deviceFilter[0].name
    } else {
      marketName = devices[0].name
    }
  }

  return marketName
}

export async function getPerformance(deviceId: string) {
  const cpus = await getCpus(deviceId)
  const platform = await getDevicePlatform(deviceId)

  return {
    cpus,
    cpuLoads: await getCpuLoads(deviceId, cpus),
    cpuTemperature: await getCpuTemperature(deviceId),
    ...(await getMemory(deviceId)),
    // Linux 主板没有 dumpsys battery，留空而不是返回 0，避免误报电量 0%
    ...(platform.platform === 'android' ? await getBattery(deviceId) : {}),
  }
}

export async function getUptime(deviceId: string) {
  const result = await shell(deviceId, 'cat /proc/uptime')
  const [uptime] = result.split(' ')
  return Math.round(toNum(uptime) * 1000)
}

async function getBattery(deviceId: string) {
  const result = await shell(deviceId, 'dumpsys battery')

  return {
    batteryLevel: toNum(getPropValue('level', result)),
    batteryTemperature: toNum(getPropValue('temperature', result)),
    batteryVoltage: toNum(getPropValue('voltage', result)),
  }
}

export const screencap: IpcScreencap = async function (deviceId) {
  await assertAndroid(deviceId, '屏幕截图（screencap）')
  const device = await client.getDevice(deviceId)
  const data = await device.screencap()
  const buf = await Adb.util.readAll(data)

  return buf.toString('base64')
}

export const dumpWindowHierarchy: IpcDumpWindowHierarchy = async function (
  deviceId
) {
  await assertAndroid(deviceId, '界面树抓取（uiautomator）')
  const path = '/data/local/tmp/aya_uidump.xml'
  await shell(deviceId, `uiautomator dump ${path}`)
  const data = await file.pullFileData(deviceId, path)
  return data.toString('utf8')
}

async function getScreen(deviceId: string) {
  const [wmSize, wmDensity] = await shell(deviceId, ['wm size', 'wm density'])

  const physicalResolution = getPropValue('Physical size', wmSize)
  const physicalDensity = getPropValue('Physical density', wmDensity)

  const hasOverrideResolution = contain(wmSize, 'Override')
  const hasOverrideDensity = contain(wmDensity, 'Override')
  const resolution = hasOverrideResolution
    ? getPropValue('Override size', wmSize)
    : physicalResolution
  const density = hasOverrideDensity
    ? getPropValue('Override density', wmDensity)
    : physicalDensity

  return {
    resolution,
    physicalResolution,
    density,
    physicalDensity,
  }
}

async function getMemory(deviceId: string) {
  const memInfo = await shell(deviceId, 'cat /proc/meminfo')
  let memTotal = 0
  let memFree = 0

  const totalMatch = getPropValue('MemTotal', memInfo)
  let freeMatch = getPropValue('MemAvailable', memInfo)
  if (!freeMatch) {
    freeMatch = getPropValue('MemFree', memInfo)
  }
  if (totalMatch && freeMatch) {
    memTotal = parseInt(totalMatch, 10) * 1024
    memFree = parseInt(freeMatch, 10) * 1024
  }

  return {
    memTotal,
    memUsed: memTotal - memFree,
  }
}

async function getStorage(deviceId: string) {
  const storageInfo = await shell(deviceId, 'dumpsys diskstats')
  let storageTotal = 0
  let storageFree = 0

  const match = storageInfo.match(new RegExp('Data-Free: (\\d+)K / (\\d+)K'))
  if (match) {
    storageFree = parseInt(match[1], 10) * 1024
    storageTotal = parseInt(match[2], 10) * 1024
  }

  return {
    storageTotal,
    storageUsed: storageTotal - storageFree,
  }
}

function getPropValue(key: string, str: string) {
  const lines = str.split('\n')
  for (let i = 0, len = lines.length; i < len; i++) {
    const line = trim(lines[i])
    if (startWith(line, key)) {
      return trim(line.replace(/.*:/, ''))
    }
  }

  return ''
}

const connectDevice: IpcConnectDevice = async function (host, port) {
  await client.connect(host, port)
}

const disconnectDevice: IpcDisconnectDevice = async function (host, port) {
  await client.disconnect(host, port)
}

const pairDevice: IpcPairDevice = async function (host, port, password) {
  const { stdout } = await spawnAdb(['pair', `${host}:${port}`, password])
  if (!contain(stdout, 'Successfully')) {
    throw new Error(`Pair device failed: ${stdout}`)
  }
}

export const inputKey: IpcInputKey = async function (deviceId, keyCode) {
  await assertAndroid(deviceId, '按键注入（input keyevent）')
  await base.shell(deviceId, `input keyevent ${keyCode}`)
}

export const inputTap: IpcInputTap = async function (deviceId, x, y) {
  await assertAndroid(deviceId, '点击注入（input tap）')
  return base.shell(deviceId, `input tap ${Math.round(x)} ${Math.round(y)}`)
}

export const inputSwipe: IpcInputSwipe = async function (
  deviceId,
  x1,
  y1,
  x2,
  y2,
  duration = 300
) {
  await assertAndroid(deviceId, '滑动注入（input swipe）')
  return base.shell(
    deviceId,
    `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(
      x2
    )} ${Math.round(y2)} ${Math.round(duration)}`
  )
}

export const inputText: IpcInputText = async function (deviceId, text) {
  await assertAndroid(deviceId, '文本注入（input text）')
  return base.shell(deviceId, `input text ${text}`)
}

async function openAdbCli() {
  let cwd = resolveResources('adb')
  const adbPath = settingsStore.get('adbPath')
  if (!isStrBlank(adbPath) && fs.existsSync(adbPath)) {
    cwd = path.dirname(adbPath)
  } else if (isWindows) {
    // Microsoft store app permission issue workaround
    const newCwd = getUserDataPath('adb')
    if (!(await fs.existsSync(newCwd))) {
      await fs.copy(cwd, newCwd)
    }
    cwd = newCwd
  }

  if (isMac) {
    const child = childProcess.spawn('open', ['-a', 'Terminal', cwd], {
      stdio: 'ignore',
    })
    child.unref()
  } else if (isWindows) {
    const child = childProcess.exec('start cmd', {
      cwd,
    })
    child.unref()
  } else {
    const child = childProcess.spawn('x-terminal-emulator', ['-w', cwd], {
      stdio: 'ignore',
    })
    child.unref()
  }
}

async function root(deviceId: string) {
  const id = await shell(deviceId, 'id')
  if (contain(id, 'uid=0')) {
    return
  }
  const device = await client.getDevice(deviceId)
  await device.root()
}

async function startWireless(deviceId: string) {
  const device = await client.getDevice(deviceId)
  const { ip } = await getIpAndMac(deviceId)
  const port = await device.tcpip(5555)
  await sleep(500)
  await connectDevice(ip, port)
}

async function restartAdbServer() {
  await client.kill()
  await client.version()
}

export async function init() {
  logger.info('init')

  app.on('will-quit', async () => {
    if (settingsStore.get('killAdbWhenExit')) {
      logger.info('kill adb')
      await client.kill()
    }
  })

  client = Adb.createClient({
    bin: getAdbPath(),
  })
  async function track() {
    logger.info('track devices')
    try {
      const tracker = await client.trackDevices()
      tracker.on('add', onDeviceChange)
      tracker.on('remove', onDeviceChange)
      tracker.on('error', () => {
        logger.error('tracker error')
      })
      tracker.on('end', async () => {
        logger.info('tracker end')
        await sleep(2000)
        track()
      })
    } catch (e) {
      logger.error('track error', e)
      // adb server 可能尚未启动（冷启动），等待后重试，否则设备列表会永远为空
      await sleep(2000)
      track()
      return
    }
    // adb 就绪后主动通知渲染进程刷新一次设备列表，兜底启动早期的失败查询
    setTimeout(() => window.sendAll('changeDevice'), 2000)
  }
  function onDeviceChange() {
    logger.info('device change')
    setTimeout(() => window.sendAll('changeDevice'), 2000)
  }
  track()

  base.init(client)
  logcat.init(client)
  shellAdb.init(client)
  server.init(client)
  scrcpy.init(client)
  packageAdb.init(client)
  file.init(client)
  fps.init()
  webview.init()
  port.init(client)

  handleEvent('getDevices', getDevices)
  handleEvent('getOverview', getOverview)
  handleEvent('setFontScale', setFontScale)
  handleEvent('screencap', screencap)
  handleEvent('getMemory', getMemory)
  handleEvent('getPerformance', getPerformance)
  handleEvent('getUptime', getUptime)
  handleEvent('connectDevice', connectDevice)
  handleEvent('disconnectDevice', disconnectDevice)
  handleEvent('inputKey', inputKey)
  handleEvent('inputTap', inputTap)
  handleEvent('inputSwipe', inputSwipe)
  handleEvent('inputText', inputText)
  handleEvent('openAdbCli', openAdbCli)
  handleEvent('dumpWindowHierarchy', dumpWindowHierarchy)
  handleEvent('root', root)
  handleEvent('startWireless', startWireless)
  handleEvent('restartAdbServer', restartAdbServer)
  handleEvent('pairDevice', pairDevice)
}
