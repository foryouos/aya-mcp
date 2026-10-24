import BaseStore from 'share/renderer/store/BaseStore'
import { IDevice } from 'common/types'
import { action, makeObservable, observable, runInAction, toJS } from 'mobx'
import ScrcpyClient from './lib/ScrcpyClient'
import { ScrcpyOptions3_1 } from '@yume-chan/scrcpy'
import defaults from 'licia/defaults'
import getUrlParam from 'licia/getUrlParam'

class Store extends BaseStore {
  device!: IDevice
  scrcpyClient!: ScrcpyClient
  alwaysOnTop = false
  settings = defaultSettings
  screenOff = false
  recording = false
  // MCP 指定设备时固定投屏目标，不再跟随主窗口的选中设备
  pinnedDeviceId = ''
  constructor() {
    super()

    makeObservable(this, {
      alwaysOnTop: observable,
      settings: observable,
      device: observable,
      screenOff: observable,
      recording: observable,
      setAlwaysOnTop: action,
      turnOnScreen: action,
      turnOffScreen: action,
      startRecording: action,
      stopRecording: action,
    })

    this.init()
    this.bindEvent()
  }
  setAlwaysOnTop(val: boolean) {
    this.alwaysOnTop = val
    main.setScreencastStore('alwaysOnTop', val)
    main.setScreencastAlwaysOnTop(val)
  }
  turnOnScreen() {
    this.screenOff = false
    this.scrcpyClient.turnOnScreen()
  }
  turnOffScreen() {
    this.screenOff = true
    this.scrcpyClient.turnOffScreen()
  }
  startRecording() {
    this.recording = true
    this.scrcpyClient.startRecording()
  }
  stopRecording() {
    this.recording = false
    this.scrcpyClient.stopRecording()
  }
  async setDevice(device: IDevice | null) {
    if (device === null) {
      main.closeScreencast()
    } else {
      const deviceSettings = await main.getScreencastStore('settings')
      let settings = defaultSettings
      if (deviceSettings[device.id]) {
        settings = deviceSettings[device.id]
        defaults(settings, defaultSettings)
      }

      this.scrcpyClient = new ScrcpyClient(
        device.id,
        new ScrcpyOptions3_1({
          audio: true,
          videoBitRate: settings.videoBitRate,
          maxSize: settings.maxSize,
          clipboardAutosync: true,
          stayAwake: true,
        })
      )
      this.scrcpyClient.on('close', () => {
        if (this.device.id === device.id) {
          this.setDevice(null)
        }
      })

      runInAction(() => {
        this.settings = settings
        this.screenOff = false
        this.device = device
      })
    }
  }
  async setSettings(name: string, val: any) {
    runInAction(() => (this.settings[name] = val))
    const deviceSettings = await main.getScreencastStore('settings')
    deviceSettings[this.device.id] = toJS(this.settings)
    main.setScreencastStore('settings', deviceSettings)
  }
  private async init() {
    const device = await this.resolveInitialDevice()
    this.setDevice(device)
    const alwaysOnTop = await main.getScreencastStore('alwaysOnTop')
    if (alwaysOnTop) {
      main.setScreencastAlwaysOnTop(true)
      runInAction(() => (this.alwaysOnTop = true))
    }
  }
  // 窗口带 deviceId 打开时（MCP 指定设备）固定该设备，否则跟随主窗口选中项
  private async resolveInitialDevice() {
    this.pinnedDeviceId = getUrlParam('deviceId') || ''
    if (this.pinnedDeviceId) {
      try {
        const devices = await main.getDevices()
        const found = devices.find((item) => item.id === this.pinnedDeviceId)
        if (found) {
          return found
        }
      } catch {
        // adb 尚未就绪时回退到主窗口的选中设备
      }
    }

    return await main.getMainStore('device')
  }
  private bindEvent() {
    main.on('changeMainStore', (name: string, val: any) => {
      if (name === 'device' && !this.pinnedDeviceId) {
        this.setDevice(val)
      }
    })
    main.on('focusWin', async () => {
      const text = await navigator.clipboard.readText()
      this.scrcpyClient.setClipboard(text)
    })
  }
}

const defaultSettings = {
  videoBitRate: 8000000,
  maxSize: 0,
}

export default new Store()
