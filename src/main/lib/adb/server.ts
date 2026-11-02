import types from 'licia/types'
import uuid from 'licia/uuid'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import singleton from 'licia/singleton'
import wire from '../wire'
import waitUntil from 'licia/waitUntil'
import {
  forwardTcp,
  getDeviceStore,
  setDeviceStore,
  shell,
  withTimeout,
} from './base'
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

// 单条 RPC 的默认超时。设备端是「每连接一线程 + 请求串行」，
// 没有超时的话设备端一卡，前端就会永久停在 loading 上。
const DEFAULT_RPC_TIMEOUT = 30 * 1000
// 建连（含 push + 拉起设备端服务）整体上限。
// 设备刚重启时 app_process 起得慢，需要留足时间
const CONNECT_TIMEOUT = 40 * 1000
// 单帧上限：长度前缀错位（比如缓冲区被截断）时避免无限等待与内存膨胀
const MAX_FRAME_SIZE = 64 * 1024 * 1024

interface IPendingRequest {
  resolve: (value?: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * 从缓冲区切出一个长度前缀帧（protobuf delimited）。
 * 返回 null 表示数据还没收全；长度前缀非法时抛错，由调用方重置缓冲区。
 */
function readDelimitedFrame(
  buf: Buffer
): { payload: Buffer; end: number } | null {
  let len = 0
  let shift = 0
  let pos = 0
  while (pos < buf.length) {
    const byte = buf[pos]
    pos++
    // 用乘法而不是位移，避免长度超过 2^31 时的符号问题
    len += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) {
      break
    }
    shift += 7
    if (shift > 28) {
      throw new Error('invalid frame length')
    }
  }
  // 长度前缀本身还没收全
  if (pos === 0 || (buf[pos - 1] & 0x80) !== 0) {
    return null
  }
  if (len > MAX_FRAME_SIZE) {
    throw new Error(`frame too large: ${len}`)
  }
  if (buf.length < pos + len) {
    return null
  }

  return { payload: buf.subarray(pos, pos + len), end: pos + len }
}

// 所有实例（含 ui.watch 的独立连接），设备变化时统一断开
const ayaClients: Set<AyaClient> = new Set()

class AyaClient {
  private deviceId = ''
  private socket: any = null
  private buf: Buffer = Buffer.alloc(0)
  private resolves: Map<string, IPendingRequest> = new Map()
  constructor(deviceId: string) {
    this.deviceId = deviceId
    ayaClients.add(this)
  }
  async sendMessage(
    method: string,
    params: types.PlainObj<any> = {},
    timeoutMs = DEFAULT_RPC_TIMEOUT
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
      // 设备重启时 openLocal 可能既不 resolve 也不 reject。
      // 没有这层超时，sendMessage 会一直挂着，singleton 还会把这个
      // pending 请求缓存下来，导致后续重试永远复用同一个死 Promise。
      await withTimeout(
        this.connect(),
        CONNECT_TIMEOUT,
        `aya server connect timeout after ${CONNECT_TIMEOUT}ms`
      )
    }
    if (!this.socket) {
      throw new Error('aya server not connected')
    }

    const id = uuid()
    // 先登记再写，避免响应比登记更快到达
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolves.delete(id)
        const err = new Error(
          `aya rpc ${method} timeout after ${timeoutMs}ms`
        )
        // 超时说明这条连接已经不可用（设备重启等半开场景不会触发 close）。
        // 不主动断开的话，后续请求会继续写到死 socket 上，重试永远失败。
        this.close(err.message)
        reject(err)
      }, timeoutMs)
      // 未完成的 RPC 不应该阻止进程退出
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      this.resolves.set(id, { resolve, reject, timer })
    })

    try {
      this.socket.write(
        wire.io.liriliri.aya.Request.encodeDelimited({
          id,
          method,
          params: JSON.stringify(params),
        }).finish()
      )
    } catch (err) {
      this.rejectRequest(id, toError(err))
    }

    return promise
  }
  close(reason = 'aya server connection closed') {
    const socket = this.socket
    this.socket = null
    this.buf = Buffer.alloc(0)
    this.failAll(new Error(reason))
    try {
      // destroy 而不是 end：半开连接上 end 不保证能真正释放
      if (socket && typeof socket.destroy === 'function') {
        socket.destroy()
      } else if (socket && typeof socket.end === 'function') {
        socket.end()
      }
    } catch {
      // ignore
    }
  }
  private rejectRequest(id: string, err: Error) {
    const pending = this.resolves.get(id)
    if (!pending) {
      return
    }
    this.resolves.delete(id)
    clearTimeout(pending.timer)
    pending.reject(err)
  }
  /**
   * 连接断开时把挂起的请求全部 reject。
   * 否则这些 Promise 会永久 pending，调用方（如应用列表）就永远卡在 loading。
   */
  private failAll(err: Error) {
    const pendings = this.resolves
    this.resolves = new Map()
    pendings.forEach(({ reject, timer }) => {
      clearTimeout(timer)
      reject(err)
    })
  }
  private onDisconnect(socket: any, err?: Error) {
    // 旧 socket 的迟到事件不能影响新连接
    if (this.socket && this.socket !== socket) {
      return
    }
    logger.warn('disconnect', err ? err.message : '')
    this.socket = null
    this.buf = Buffer.alloc(0)
    this.failAll(err || new Error('aya server connection closed'))
  }
  private drainResponses() {
    while (this.buf.length > 0) {
      let frame: { payload: Buffer; end: number } | null
      try {
        frame = readDelimitedFrame(this.buf)
      } catch (err) {
        // 流已错位，丢弃缓冲，等下一个完整响应重建
        logger.warn('invalid response frame, reset buffer', err)
        this.buf = Buffer.alloc(0)
        return
      }
      if (!frame) {
        break
      }
      this.buf = this.buf.subarray(frame.end)
      try {
        const { id, result } = wire.io.liriliri.aya.Response.decode(
          frame.payload
        )
        const pending = this.resolves.get(id)
        if (pending) {
          this.resolves.delete(id)
          clearTimeout(pending.timer)
          pending.resolve(JSON.parse(result))
        }
      } catch (err) {
        logger.warn('decode response failed', err)
      }
    }
  }
  private async connect(tryStart = true) {
    logger.info('connect')
    try {
      const device = client.getDevice(this.deviceId)
      const socket = await device.openLocal('localabstract:aya')
      this.buf = Buffer.alloc(0)
      socket.on('readable', () => {
        let chunk
        while (null !== (chunk = socket.read())) {
          this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
        }
        this.drainResponses()
      })
      socket.on('end', () => this.onDisconnect(socket))
      socket.on('close', () => this.onDisconnect(socket))
      socket.on('error', (err: Error) => this.onDisconnect(socket, err))
      this.socket = socket
    } catch (err) {
      if (tryStart) {
        await this.push()
        await this.start()
        await waitUntil(() => this.isRunning(), 20000, 200)
        await this.connect(false)
      } else {
        throw err
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
      // 这里的超时要比自身 race 留得更长，让 race 决定最终错误信息
      client.sendMessage('ui.watch', params, Math.max(timeoutMs, 1000) + 5000),
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

/**
 * 设备重启/断开时调用。
 * 此时主机侧的 socket 往往是半开的（既收不到 FIN 也收不到错误），
 * 不主动断开的话下一次请求会继续写到死连接上，只能一直等到超时。
 */
export function resetAyaClients(reason = 'device changed') {
  ayaClients.forEach((ayaClient) => ayaClient.close(reason))
  each(watchClients, (_, deviceId) => delete watchClients[deviceId])
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
  // 设备端是逐包串行解析 APK 资源 + 生成图标，一批 50 个包耗时可能几十秒。
  // 必须短于渲染进程的超时，否则前端重试时会复用这里还没结束的 pending 请求
  const result = await client.sendMessage(
    'getPackageInfos',
    { packageNames },
    60 * 1000
  )
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
    const { running } = await client.sendMessage(
      'isFileServerRunning',
      {},
      15 * 1000
    )
    if (running) {
      return port
    }
  }
  const result = await client.sendMessage('startFileServer', {}, 15 * 1000)
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
