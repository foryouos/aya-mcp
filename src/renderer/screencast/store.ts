import BaseStore from 'share/renderer/store/BaseStore'
import { IDevice } from 'common/types'
import { action, makeObservable, observable, runInAction } from 'mobx'
import ScrcpyClient from './lib/ScrcpyClient'
import { ScrcpyOptions3_1 } from '@yume-chan/scrcpy'
import defaults from 'licia/defaults'
import getUrlParam from 'licia/getUrlParam'
import { t } from 'common/util'

export type ScreencastLayout = 'grid' | 'spotlight'

export interface IScreenTile {
  device: IDevice
  loading: boolean
  error: string
  stalled: boolean
  screenOff: boolean
  recording: boolean
}

export interface IScrcpySettings {
  videoBitRate: number
  maxSize: number
}

// 单窗口内最多同时投屏的设备数。H.264 硬解器实例数有上限，
// 超过 6 路会退化成软解直接卡死，所以必须在入口拦住
export const MAX_TILES = 6
// 达到这个路数开始降档，避免多路原分辨率把解码器压满
const DOWNGRADE_TILES = 3
const DOWNGRADE_MAX_SIZE = 1024
const DOWNGRADE_MAX_FPS = 30
// 设备掉线后先观察一会儿再下线，避免无线连接抖动把整格踢掉
const OFFLINE_CONFIRM_DELAY = 3000

export const defaultSettings: IScrcpySettings = {
  videoBitRate: 8000000,
  maxSize: 0,
}

class Store extends BaseStore {
  tiles: IScreenTile[] = []
  // 工具栏按钮（电源 / 音量 / 截图 / 录屏）的作用目标
  activeDeviceId = ''
  // spotlight 布局下放大的那一路
  focusDeviceId = ''
  layout: ScreencastLayout = 'grid'
  alwaysOnTop = false
  // 当前活动设备的画质参数
  settings: IScrcpySettings = { ...defaultSettings }
  // MCP / 命令行指定设备时固定投屏目标，不再跟随主窗口的选中设备
  pinnedDeviceIds: string[] = []
  lastError = ''
  // ScrcpyClient 不能放进 observable：内部持有 socket / decoder / Set，
  // 被 mobx 代理会影响这些流对象的方法调用
  private clients = new Map<string, ScrcpyClient>()
  // 掉线待确认的设备，避免 adb 抖动导致误下线
  private offlineTimers = new Map<string, NodeJS.Timeout>()

  constructor() {
    super()

    makeObservable(this, {
      tiles: observable.shallow,
      activeDeviceId: observable,
      focusDeviceId: observable,
      layout: observable,
      alwaysOnTop: observable,
      settings: observable,
      lastError: observable,
      setAlwaysOnTop: action,
      setActive: action,
      setLayout: action,
      setFocus: action,
      clearError: action,
    })

    this.init()
    this.bindEvent()
  }
  getClient(deviceId: string) {
    return this.clients.get(deviceId)
  }
  get tile() {
    return (
      this.tiles.find((item) => item.device.id === this.activeDeviceId) ||
      this.tiles[0]
    )
  }
  setAlwaysOnTop(val: boolean) {
    this.alwaysOnTop = val
    main.setScreencastStore('alwaysOnTop', val)
    main.setScreencastAlwaysOnTop(val)
  }
  clearError() {
    this.lastError = ''
  }
  setActive(deviceId: string) {
    if (!this.tiles.some((item) => item.device.id === deviceId)) {
      return
    }
    this.activeDeviceId = deviceId
    this.syncSettings(deviceId)
  }
  setLayout(layout: ScreencastLayout) {
    this.layout = layout
    if (layout === 'spotlight' && !this.focusDeviceId) {
      this.focusDeviceId =
        this.activeDeviceId || (this.tiles[0] ? this.tiles[0].device.id : '')
    }
    if (layout === 'grid') {
      this.focusDeviceId = ''
    }
    main.setScreencastLayout(layout)
    this.syncAudio()
  }
  /**
   * deviceId 为空表示取消聚焦（回到等分网格）。
   * 聚焦只改 CSS 布局，不重启任何会话，保证切换过程零中断。
   */
  setFocus(deviceId: string) {
    if (deviceId && !this.tiles.some((item) => item.device.id === deviceId)) {
      return
    }
    this.focusDeviceId = deviceId
    if (deviceId) {
      this.activeDeviceId = deviceId
      this.layout = 'spotlight'
      this.syncSettings(deviceId)
    } else {
      this.layout = 'grid'
    }
    main.setScreencastLayout(this.layout)
    this.syncAudio()
  }
  turnOnScreen() {
    const tile = this.tile
    const client = tile && this.getClient(tile.device.id)
    if (!tile || !client) {
      return
    }
    this.patchTile(tile.device.id, { screenOff: false })
    client.setScreenOff(false)
    client.turnOnScreen()
  }
  turnOffScreen() {
    const tile = this.tile
    const client = tile && this.getClient(tile.device.id)
    if (!tile || !client) {
      return
    }
    this.patchTile(tile.device.id, { screenOff: true })
    // 熄屏后不再出帧属于预期行为，停掉停滞判定
    client.setScreenOff(true)
    client.turnOffScreen()
  }
  startRecording() {
    const tile = this.tile
    const client = tile && this.getClient(tile.device.id)
    if (!tile || !client) {
      return
    }
    this.patchTile(tile.device.id, { recording: true })
    client.startRecording()
  }
  stopRecording() {
    const tile = this.tile
    const client = tile && this.getClient(tile.device.id)
    if (!tile || !client) {
      return
    }
    this.patchTile(tile.device.id, { recording: false })
    client.stopRecording()
  }
  async addDevice(device: IDevice) {
    this.clearOfflineTimer(device.id)
    if (this.tiles.some((item) => item.device.id === device.id)) {
      this.setActive(device.id)
      return
    }
    if (this.tiles.length >= MAX_TILES) {
      this.lastError = t('screencastMaxTiles', { count: MAX_TILES })
      return
    }

    const settings = await this.readSettings(device.id)
    const focusId = this.focusDeviceId || this.activeDeviceId
    // 多路时只有聚焦设备出声，其余先静音，切换聚焦时再开
    const client = new ScrcpyClient(
      device.id,
      this.createOptions(settings),
      !focusId || focusId === device.id
    )
    this.clients.set(device.id, client)

    runInAction(() => {
      this.tiles = [
        ...this.tiles,
        {
          device,
          loading: true,
          error: '',
          stalled: false,
          screenOff: false,
          recording: false,
        },
      ]
      if (!this.activeDeviceId) {
        this.activeDeviceId = device.id
      }
      if (!this.focusDeviceId) {
        this.focusDeviceId = device.id
      }
    })

    client.on('stalled', () => {
      this.patchTile(device.id, { stalled: true })
    })
    client.on('recovered', () => {
      this.patchTile(device.id, { stalled: false })
    })
    // 单路断开不能关掉整个窗口，只把这一格标记为异常，其它设备继续播
    client.on('close', () => {
      if (this.getClient(device.id) !== client) {
        return
      }
      this.patchTile(device.id, {
        error: t('screencastDisconnected'),
        loading: false,
      })
    })

    this.syncSettings(this.activeDeviceId)
    this.syncAudio()
    this.syncDevicesToMain()
  }
  setTileLoaded(deviceId: string) {
    this.patchTile(deviceId, { loading: false, error: '', stalled: false })
  }
  setTileError(deviceId: string, error: string) {
    this.patchTile(deviceId, { loading: false, error })
  }
  /** 只重建这一路会话，不影响其它设备（原 restartScreencast 会关掉整个窗口） */
  async reloadTile(deviceId: string) {
    const tile = this.tiles.find((item) => item.device.id === deviceId)
    if (!tile) {
      return
    }
    const device = tile.device

    // 设备已经掉线时重连必然超时，直接下线，别让用户白等 20 秒
    try {
      const devices = await main.getDevices()
      const online = devices.some(
        (item) =>
          item.id === deviceId &&
          (item.type === 'device' || item.type === 'emulator')
      )
      if (!online) {
        this.removeDevice(deviceId)
        return
      }
    } catch {
      // 查询失败时按在线处理，走正常重连
    }

    this.removeDeviceSilently(deviceId)
    await this.addDevice(device)
  }
  /** 重建全部会话（改画质参数后使用），保留当前设备与顺序，不关窗口 */
  async reloadAll() {
    const devices = this.tiles.map((item) => item.device)
    if (!devices.length) {
      return
    }
    const ids: string[] = []
    this.clients.forEach((_, deviceId) => ids.push(deviceId))
    for (let i = 0, len = ids.length; i < len; i++) {
      this.removeDeviceSilently(ids[i])
    }
    await this.setDevices(devices)
  }
  removeDevice(deviceId: string) {
    this.clearOfflineTimer(deviceId)
    const index = this.tiles.findIndex((item) => item.device.id === deviceId)
    if (index < 0) {
      return
    }

    const client = this.clients.get(deviceId)
    this.clients.delete(deviceId)
    if (client) {
      client.destroy()
    }

    const tiles = this.tiles.slice()
    tiles.splice(index, 1)
    runInAction(() => {
      this.tiles = tiles
      if (this.activeDeviceId === deviceId) {
        this.activeDeviceId = tiles[0] ? tiles[0].device.id : ''
      }
      if (this.focusDeviceId === deviceId) {
        this.focusDeviceId = tiles[0] ? tiles[0].device.id : ''
        if (!this.focusDeviceId) {
          this.layout = 'grid'
        }
      }
    })

    if (!tiles.length) {
      main.closeScreencast()
      return
    }

    this.syncSettings(this.activeDeviceId)
    this.syncAudio()
    this.syncDevicesToMain()
  }
  /** 用给定设备列表整体替换当前投屏内容（MCP 指定目标时使用） */
  async setDevices(devices: IDevice[]) {
    const next: IDevice[] = []
    const seen: string[] = []
    for (let i = 0, len = devices.length; i < len; i++) {
      const device = devices[i]
      if (!device || seen.indexOf(device.id) >= 0) {
        continue
      }
      seen.push(device.id)
      next.push(device)
    }
    const limited = next.slice(0, MAX_TILES)

    const keep: string[] = limited.map((item) => item.id)
    const removed: string[] = []
    for (let i = 0, len = this.tiles.length; i < len; i++) {
      if (keep.indexOf(this.tiles[i].device.id) < 0) {
        removed.push(this.tiles[i].device.id)
      }
    }
    for (let i = 0, len = removed.length; i < len; i++) {
      this.removeDeviceSilently(removed[i])
    }

    if (!limited.length) {
      main.closeScreencast()
      return
    }

    for (let i = 0, len = limited.length; i < len; i++) {
      const device = limited[i]
      if (!this.tiles.some((item) => item.device.id === device.id)) {
        await this.addDevice(device)
      }
    }

    // 顺序与请求保持一致
    runInAction(() => {
      const ordered: IScreenTile[] = []
      for (let i = 0, len = keep.length; i < len; i++) {
        const tile = this.tiles.find((item) => item.device.id === keep[i])
        if (tile) {
          ordered.push(tile)
        }
      }
      this.tiles = ordered
      const focus = this.focusDeviceId
      if (!focus || keep.indexOf(focus) < 0) {
        this.focusDeviceId = keep[0]
        if (this.layout === 'spotlight') {
          this.activeDeviceId = keep[0]
        }
      }
    })

    this.syncSettings(this.activeDeviceId)
    this.syncAudio()
    this.syncDevicesToMain()
  }
  async setSettings(name: string, val: any) {
    const tile = this.tile
    if (!tile) {
      return
    }
    const deviceId = tile.device.id
    const current = await this.readSettings(deviceId)
    current[name] = val
    runInAction(() => (this.settings = { ...current }))

    const deviceSettings = await main.getScreencastStore('settings')
    deviceSettings[deviceId] = current
    main.setScreencastStore('settings', deviceSettings)
  }
  private clearOfflineTimer(deviceId: string) {
    const timer = this.offlineTimers.get(deviceId)
    if (timer) {
      clearTimeout(timer)
      this.offlineTimers.delete(deviceId)
    }
  }
  /**
   * 设备掉线后投屏不能继续挂着黑格，要把这一路下线。
   * adb 偶尔会把无线设备短暂标记为 offline，所以延迟确认再移除。
   */
  private handleDeviceChange = async () => {
    let devices: IDevice[] = []
    try {
      devices = await main.getDevices()
    } catch {
      return
    }

    const online: string[] = []
    for (let i = 0, len = devices.length; i < len; i++) {
      const device = devices[i]
      if (device.type === 'device' || device.type === 'emulator') {
        online.push(device.id)
      }
    }

    const tiles = this.tiles.slice()
    for (let i = 0, len = tiles.length; i < len; i++) {
      const deviceId = tiles[i].device.id
      if (online.indexOf(deviceId) >= 0) {
        this.clearOfflineTimer(deviceId)
        continue
      }
      if (this.offlineTimers.has(deviceId)) {
        continue
      }
      this.offlineTimers.set(
        deviceId,
        setTimeout(() => {
          this.offlineTimers.delete(deviceId)
          if (this.tiles.some((item) => item.device.id === deviceId)) {
            this.removeDevice(deviceId)
          }
        }, OFFLINE_CONFIRM_DELAY)
      )
    }
  }
  private removeDeviceSilently(deviceId: string) {
    this.clearOfflineTimer(deviceId)
    const index = this.tiles.findIndex((item) => item.device.id === deviceId)
    if (index < 0) {
      return
    }
    const client = this.clients.get(deviceId)
    this.clients.delete(deviceId)
    if (client) {
      client.destroy()
    }
    const tiles = this.tiles.slice()
    tiles.splice(index, 1)
    runInAction(() => (this.tiles = tiles))
  }
  private patchTile(deviceId: string, patch: Partial<IScreenTile>) {
    const index = this.tiles.findIndex((item) => item.device.id === deviceId)
    if (index < 0) {
      return
    }
    const tiles = this.tiles.slice()
    tiles[index] = { ...tiles[index], ...patch }
    runInAction(() => (this.tiles = tiles))
  }
  /**
   * 多设备同屏时只让一路出声，否则会混音成噪音。
   * 音频流保持解码，只丢弃非聚焦设备的采样，切换聚焦时立即生效、无需重启会话。
   */
  private syncAudio() {
    const focusId =
      this.focusDeviceId ||
      this.activeDeviceId ||
      (this.tiles[0] ? this.tiles[0].device.id : '')
    this.clients.forEach((client, deviceId) => {
      client.setAudioEnabled(deviceId === focusId)
    })
  }
  private async syncSettings(deviceId: string) {
    if (!deviceId) {
      return
    }
    const settings = await this.readSettings(deviceId)
    if (this.activeDeviceId === deviceId) {
      runInAction(() => (this.settings = settings))
    }
  }
  private async readSettings(deviceId: string): Promise<IScrcpySettings> {
    const deviceSettings = await main.getScreencastStore('settings')
    const current = deviceSettings[deviceId]
    if (current) {
      return defaults({ ...current }, { ...defaultSettings })
    }
    return { ...defaultSettings }
  }
  // 主进程需要持有当前投屏设备列表，MCP 的 add / remove / 状态查询才有依据
  private syncDevicesToMain() {
    main.setScreencastDevices(this.tiles.map((item) => item.device.id))
  }
  private createOptions(settings: IScrcpySettings) {
    // 调用时新设备还没进入 tiles，+1 才是包含它在内的总路数
    const multi = this.tiles.length + 1 >= DOWNGRADE_TILES
    const maxSize = multi
      ? settings.maxSize > 0
        ? Math.min(settings.maxSize, DOWNGRADE_MAX_SIZE)
        : DOWNGRADE_MAX_SIZE
      : settings.maxSize

    return new ScrcpyOptions3_1({
      audio: true,
      videoBitRate: settings.videoBitRate,
      maxSize,
      maxFps: multi ? DOWNGRADE_MAX_FPS : 0,
      clipboardAutosync: true,
      stayAwake: true,
    })
  }
  private async init() {
    const alwaysOnTop = await main.getScreencastStore('alwaysOnTop')
    if (alwaysOnTop) {
      main.setScreencastAlwaysOnTop(true)
      runInAction(() => (this.alwaysOnTop = true))
    }
    const layout = await main.getScreencastStore('layout')
    if (layout === 'spotlight') {
      runInAction(() => (this.layout = 'spotlight'))
    }

    const devices = await this.resolveInitialDevices()
    if (devices.length) {
      await this.setDevices(devices)
    }
  }
  // 窗口带 deviceIds 打开时（MCP 指定设备）固定这批设备，否则跟随主窗口选中项
  private async resolveInitialDevices(): Promise<IDevice[]> {
    const raw = getUrlParam('deviceIds') || getUrlParam('deviceId') || ''
    this.pinnedDeviceIds = String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => !!item)
    if (!this.pinnedDeviceIds.length) {
      // 没有显式指定时跟随主窗口的选中设备（保持原来的单设备投屏体验）
      const current = await main.getMainStore('device')
      return current ? [current] : []
    }

    try {
      const devices = await main.getDevices()
      const found: IDevice[] = []
      for (let i = 0, len = this.pinnedDeviceIds.length; i < len; i++) {
        const device = devices.find(
          (item) => item.id === this.pinnedDeviceIds[i]
        )
        if (device) {
          found.push(device)
        }
      }
      if (found.length) {
        return found
      }
    } catch {
      // adb 尚未就绪时回退到主窗口的选中设备
    }

    const current = await main.getMainStore('device')
    return current ? [current] : []
  }
  private bindEvent() {
    main.on('changeDevice', this.handleDeviceChange)
    main.on('changeMainStore', (name: string, val: any) => {
      if (name !== 'device') {
        return
      }
      // MCP 已固定目标，或用户已经在看多台设备时，不再跟随主窗口切换
      if (this.pinnedDeviceIds.length || this.tiles.length > 1) {
        return
      }
      if (val) {
        this.setDevices([val])
      } else {
        main.closeScreencast()
      }
    })
    main.on('syncScreencastDevices', async (deviceIds: string[]) => {
      this.pinnedDeviceIds = deviceIds || []
      // 主进程回推的列表与当前一致时不必重建会话（否则会闪一下黑屏）
      const current = this.tiles.map((item) => item.device.id)
      if (
        current.length === deviceIds.length &&
        deviceIds.every((id, index) => current[index] === id)
      ) {
        return
      }

      let devices: IDevice[] = []
      try {
        devices = await main.getDevices()
      } catch {
        return
      }
      const found: IDevice[] = []
      for (let i = 0, len = deviceIds.length; i < len; i++) {
        const device = devices.find((item) => item.id === deviceIds[i])
        if (device) {
          found.push(device)
        }
      }
      await this.setDevices(found)
    })
    main.on('setScreencastFocus', (deviceId: string) => {
      this.setFocus(deviceId || '')
    })
    main.on('applyScreencastLayout', (layout: ScreencastLayout) => {
      if (layout === 'grid' || layout === 'spotlight') {
        this.setLayout(layout)
      }
    })
    main.on('focusWin', async () => {
      const tile = this.tile
      const client = tile && this.getClient(tile.device.id)
      if (!client) {
        return
      }
      const text = await navigator.clipboard.readText()
      client.setClipboard(text)
    })
  }
}

export default new Store()
