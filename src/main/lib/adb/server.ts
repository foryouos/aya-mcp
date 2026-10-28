import types from 'licia/types'
import uuid from 'licia/uuid'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import singleton from 'licia/singleton'
import wire from '../wire'
import waitUntil from 'licia/waitUntil'
import { forwardTcp, getDeviceStore, setDeviceStore, shell } from './base'
import { getDevicePlatform, NotSupportedError } from './platform'
import contain from 'licia/contain'
import log from 'share/common/log'
import { IPackageInfo, IpcGetFileUrl, IpcGetPackageInfos } from 'common/types'
import isEmpty from 'licia/isEmpty'
import isUndef from 'licia/isUndef'
import each from 'licia/each'
import startWith from 'licia/startWith'
import extend from 'licia/extend'
import toNum from 'licia/toNum'

const logger = log('server')

let client: Client

class AyaClient {
  private deviceId = ''
  private socket: any = null
  private resolves: Map<string, (value?: any) => void> = new Map()
  constructor(deviceId: string) {
    this.deviceId = deviceId
  }
  async sendMessage(
    method: string,
    params: types.PlainObj<any> = {}
  ): Promise<any> {
    // 设备端服务是 aya.dex + app_process + UiAutomation，Linux 主板必然起不来。
    // 提前拦掉，否则 push→start→waitUntil 会白等 10 秒才报错。
    const platform = await getDevicePlatform(this.deviceId)
    if (platform.platform !== 'android') {
      throw new NotSupportedError(
        `UI/应用相关能力依赖设备端 AYA 服务（Android app_process + UiAutomation），当前设备是 ${
          platform.name || 'Linux'
        }，不支持该能力`
      )
    }

    if (!this.socket) {
      await this.connect()
    }

    const id = uuid()

    this.socket.write(
      wire.io.liriliri.aya.Request.encodeDelimited({
        id,
        method,
        params: JSON.stringify(params),
      }).finish()
    )

    return new Promise((resolve) => {
      this.resolves.set(id, resolve)
    })
  }
  close() {
    const socket = this.socket
    this.socket = null
    try {
      if (socket && typeof socket.end === 'function') {
        socket.end()
      }
    } catch {
      // ignore
    }
    this.resolves.forEach((resolve) => resolve(undefined))
    this.resolves.clear()
  }
  private async connect(tryStart = true) {
    logger.info('connect')
    try {
      const device = client.getDevice(this.deviceId)
      const socket = await device.openLocal('localabstract:aya')
      let buf = Buffer.alloc(0)
      socket.on('readable', () => {
        const newBuf = socket.read()
        if (!newBuf) {
          return
        }
        buf = Buffer.concat([buf, newBuf])
        try {
          const message = wire.io.liriliri.aya.Response.decodeDelimited(buf)
          buf = Buffer.alloc(0)
          const { id, result } = message
          const resolve = this.resolves.get(id)
          if (resolve) {
            resolve(JSON.parse(result))
          }
        } catch {
          // ignore
        }
      })
      socket.on('end', () => (this.socket = null))
      this.socket = socket
    } catch {
      if (tryStart) {
        await this.push()
        await this.start()
        await waitUntil(() => this.isRunning(), 10000, 100)
        await this.connect(false)
      }
    }
  }
  // 不能用 singleton：设备端服务刚拉起时第一次查询往往还是 false，
  // 结果被缓存后 waitUntil 会一直拿到 false 直到 10s 超时。
  // 这里每次真实查询，只在「连接已失败、准备重启设备端服务」的路径上调用，开销可忽略。
  private async isRunning() {
    const result: string = await shell(this.deviceId, `cat /proc/net/unix`)
    return contain(result, '@aya')
  }
  private async push() {
    logger.info('push')
    const device = client.getDevice(this.deviceId)
    await device.push(
      resolveResources('aya.dex'),
      '/data/local/tmp/aya/aya.dex'
    )
  }
  private async start() {
    logger.info('start')
    const device = client.getDevice(this.deviceId)
    await device.shell(
      'CLASSPATH=/data/local/tmp/aya/aya.dex app_process /system/bin io.liriliri.aya.Server'
    )
  }
}

async function getAyaClient(deviceId: string): Promise<AyaClient> {
  let ayaClient = getDeviceStore(deviceId, 'ayaClient')
  if (!ayaClient) {
    ayaClient = new AyaClient(deviceId)
    setDeviceStore(deviceId, 'ayaClient', ayaClient)
  }
  return ayaClient
}

/**
 * 常驻 UiAutomation 通道取界面树（uiautomator 同构 XML）。
 * 失败时抛错，由调用方降级到 `uiautomator dump`。
 */
export async function dumpUiXml(
  deviceId: string,
  options: { maxNodes?: number; maxDepth?: number } = {}
): Promise<string> {
  const ayaClient = await getAyaClient(deviceId)
  const result = await ayaClient.sendMessage('ui.dump', options)
  if (result && result.error) {
    throw new Error(String(result.error))
  }

  return (result && result.xml) || ''
}

export interface IGestureStep {
  action: 'down' | 'move' | 'up' | 'cancel'
  x?: number
  y?: number
  delayMs?: number
}

/**
 * 通过常驻 UiAutomation 注入一次完整触摸事件流（down → ... → up）。
 * input swipe 每次都会完整按下抬起，且只能走直线，所以长按拖拽/多段路径只能走这里。
 */
export async function injectGesture(
  deviceId: string,
  params: {
    steps: IGestureStep[]
    captureAt?: number
    maxNodes?: number
    maxDepth?: number
  }
): Promise<{ xml?: string; totalMs?: number }> {
  const ayaClient = await getAyaClient(deviceId)
  const result = await ayaClient.sendMessage('ui.gesture', params)
  if (result && result.error) {
    throw new Error(String(result.error))
  }

  return (result && result.gesture) || {}
}

export async function getUiState(deviceId: string): Promise<{
  available: boolean
  error: string
  mainLoop: boolean
}> {
  const ayaClient = await getAyaClient(deviceId)
  const result = await ayaClient.sendMessage('ui.state')

  return (result && result.state) || { available: false, error: '', mainLoop: false }
}

/**
 * 注入类 RPC：调用常驻 UiAutomation 完成点击/滑动/按键/文本，
 * 省掉 `adb shell input` 每次新起进程的开销（实测 200-400ms → 几十毫秒）。
 */
export interface IInjectResult {
  ok?: boolean
  totalMs?: number
  steps?: number
  keycode?: number
  applied?: boolean
  previousText?: string
  length?: number
}

function unwrap<T>(result: any, key: string): T {
  if (result && result.error) {
    throw new Error(String(result.error))
  }

  return (result && result[key]) || ({} as T)
}

async function sendInject(
  deviceId: string,
  method: string,
  params: Record<string, unknown>,
  key: string
) {
  const client = await getAyaClient(deviceId)

  return unwrap<IInjectResult>(await client.sendMessage(method, params), key)
}

export async function injectTap(
  deviceId: string,
  x: number,
  y: number,
  pressMs = 20
) {
  return sendInject(deviceId, 'ui.tap', { x, y, pressMs }, 'tap')
}

export async function injectSwipe(
  deviceId: string,
  coords: { x1: number; y1: number; x2: number; y2: number },
  durationMs = 300
) {
  return sendInject(
    deviceId,
    'ui.swipe',
    { ...coords, durationMs },
    'swipe'
  )
}

export async function injectKey(deviceId: string, keycode: number) {
  return sendInject(deviceId, 'ui.key', { keycode }, 'key')
}

export async function injectText(
  deviceId: string,
  text: string,
  append = false
) {
  return sendInject(deviceId, 'ui.text', { text, append }, 'text')
}

export interface IUiScreenshot {
  data: string
  format: 'jpeg' | 'png'
  quality: number | null
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  bytes: number
  totalMs: number
}

export async function uiScreenshot(
  deviceId: string,
  options: { maxWidth?: number; quality?: number; format?: 'jpeg' | 'png' } = {}
): Promise<IUiScreenshot> {
  const client = await getAyaClient(deviceId)
  const result = await client.sendMessage('ui.screenshot', {
    maxWidth: options.maxWidth === undefined ? 900 : options.maxWidth,
    quality: options.quality === undefined ? 72 : options.quality,
    format: options.format || 'jpeg',
  })

  return unwrap<IUiScreenshot>(result, 'shot')
}

export interface IUiWatchEvent {
  type: string
  pkg: string
  cls: string
  text: string
  at: number
  count: number
}

export interface IUiWatchResult {
  ok?: boolean
  matched?: boolean
  waitedMs?: number
  timeoutMs?: number
  settleMs?: number
  events?: IUiWatchEvent[]
  matchedEvent?: IUiWatchEvent | null
  eventTotal?: number
}

// ui.watch 是阻塞 RPC（最长 15s），必须走独立连接，
// 否则会堵住同一 socket 上排队的其它工具调用（服务端按连接串行处理请求）
const watchClients: { [deviceId: string]: AyaClient } = {}

function getWatchClient(deviceId: string) {
  let client = watchClients[deviceId]
  if (!client) {
    client = new AyaClient(deviceId)
    watchClients[deviceId] = client
  }

  return client
}

export async function watchUi(
  deviceId: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<IUiWatchResult> {
  const client = getWatchClient(deviceId)
  let timer: NodeJS.Timeout | undefined

  try {
    const result = await Promise.race([
      client.sendMessage('ui.watch', params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ui.watch timeout')),
          Math.max(timeoutMs, 1000) + 2000
        )
      }),
    ])

    return unwrap<IUiWatchResult>(result, 'watch')
  } catch (err) {
    // 设备端 watch 线程可能还阻塞在自己的 timeout 里，
    // 关掉连接让服务端读循环感知断开；下次调用重新建连
    client.close()
    delete watchClients[deviceId]
    throw err
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function getUiCapabilities(deviceId: string) {
  const client = await getAyaClient(deviceId)
  const result = await client.sendMessage('ui.state')

  return (result && result.state) || { available: false, error: '', mainLoop: false, events: false }
}

const getPackageInfos: IpcGetPackageInfos = singleton(async function (
  deviceId,
  packageNames
) {
  // Linux 主板没有 PackageManager，返回空列表让调用方优雅降级；
  // 这里不能用抛错，singleton 会把 reject 缓存下来污染后续调用
  const platform = await getDevicePlatform(deviceId)
  if (platform.platform !== 'android') {
    return []
  }

  const client = await getAyaClient(deviceId)
  const result = await client.sendMessage('getPackageInfos', {
    packageNames,
  })
  const { packageInfos } = result
  const serverPort = await getFileServerPort(deviceId)
  if (!isEmpty(packageInfos)) {
    for (let i = 0, len = packageInfos.length; i < len; i++) {
      const info: IPackageInfo = packageInfos[i]
      if (info.icon) {
        info.icon = await getFileUrl(deviceId, info.icon, serverPort)
      }
    }
    if (isUndef(packageInfos[0].appSize)) {
      const packageDiskStats = await getPackageDiskStats(deviceId)
      for (let i = 0, len = packageInfos.length; i < len; i++) {
        const info: IPackageInfo = packageInfos[i]
        if (info.packageName && packageDiskStats[info.packageName]) {
          extend(info, packageDiskStats[info.packageName])
        } else {
          info.appSize = 0
          info.dataSize = 0
          info.cacheSize = 0
        }
      }
    }
  }
  return packageInfos
})

const getPackageDiskStats = async function (deviceId: string) {
  const diskStats = await shell(deviceId, 'dumpsys diskstats')
  const packageDiskStats: types.PlainObj<{
    appSize: number
    dataSize: number
    cacheSize: number
  }> = {}

  const packageNames: string[] = []
  const appSizes: string[] = []
  const dataSizes: string[] = []
  const cacheSizes: string[] = []

  function parseLine(line: string, prefix: string, arr: string[]) {
    if (!startWith(line, prefix)) {
      return
    }
    line = line.slice(prefix.length)
    arr.push(...JSON.parse(line))
  }
  each(diskStats.split('\n'), (line) => {
    parseLine(line, 'Package Names:', packageNames)
    parseLine(line, 'App Sizes:', appSizes)
    parseLine(line, 'App Data Sizes:', dataSizes)
    parseLine(line, 'Cache Sizes:', cacheSizes)
  })
  for (let i = 0, len = packageNames.length; i < len; i++) {
    const name = packageNames[i]
    packageDiskStats[name] = {
      appSize: toNum(appSizes[i]),
      dataSize: toNum(dataSizes[i]),
      cacheSize: toNum(cacheSizes[i]),
    }
  }

  return packageDiskStats
}

const getFileServerPort = singleton(async function (deviceId): Promise<number> {
  const client = await getAyaClient(deviceId)
  let port = getDeviceStore(deviceId, 'fileServerPort')
  if (port) {
    const { running } = await client.sendMessage('isFileServerRunning')
    if (running) {
      return port
    }
  }
  const result = await client.sendMessage('startFileServer')
  port = await forwardTcp(deviceId, `tcp:${result.port}`)
  setDeviceStore(deviceId, 'fileServerPort', port)
  return port
})

const getFileUrl: IpcGetFileUrl = async function (deviceId, path, port) {
  // 文件服务是设备端 AYA 服务的一部分，Linux 上没有；返回空串让调用方跳过预览
  const platform = await getDevicePlatform(deviceId)
  if (platform.platform !== 'android') {
    return ''
  }

  if (!port) {
    port = await getFileServerPort(deviceId)
  }

  return `http://127.0.0.1:${port}${encodeURI(path)}`
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackageInfos', getPackageInfos)
  handleEvent('getFileUrl', getFileUrl)
}
