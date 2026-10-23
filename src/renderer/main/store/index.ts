import { action, makeObservable, observable, runInAction } from 'mobx'
import isStr from 'licia/isStr'
import find from 'licia/find'
import BaseStore from 'share/renderer/store/BaseStore'
import { Settings } from './settings'
import { Application } from './application'
import { Process } from './process'
import { Webview } from './webview'
import { File } from './file'
import { Layout } from './layout'
import { Mcp } from './mcp'
import { installPackages, setMainStore } from '../../lib/util'
import { setMemStore } from 'share/renderer/lib/util'
import isEmpty from 'licia/isEmpty'
import { IDevice } from 'common/types'

class Store extends BaseStore {
  devices: IDevice[] = []
  device: IDevice | null = null
  panel: string = 'overview'
  settings = new Settings()
  application = new Application()
  process = new Process()
  webview = new Webview()
  file = new File()
  layout = new Layout()
  mcp = new Mcp()
  ready = false
  constructor() {
    super()

    makeObservable(this, {
      devices: observable,
      device: observable,
      panel: observable,
      settings: observable,
      ready: observable,
      selectDevice: action,
      selectPanel: action,
    })

    this.bindEvent()
    this.init()
  }
  selectDevice = (device: string | IDevice | null) => {
    if (isStr(device)) {
      const d = find(this.devices, ({ id }) => id === device)
      if (d) {
        this.device = d
      }
    } else {
      this.device = device
    }

    setMainStore('device', this.device)
  }
  selectPanel(panel: string) {
    this.panel = panel
    setMainStore('panel', panel)
  }
  private async init() {
    const panel = await main.getMainStore('panel')
    if (panel) {
      runInAction(() => (this.panel = panel))
    }

    const device = await main.getMainStore('device')
    if (device) {
      runInAction(() => (this.device = device))
    }
    await this.refreshDevices()

    this.ready = true

    const openFile = await main.getOpenFile('.apk')
    if (openFile && this.device) {
      installPackages(this.device.id, [openFile])
    }
  }
  refreshDevices = async () => {
    let devices: IDevice[]
    try {
      devices = await main.getDevices()
    } catch {
      // adb 未就绪等场景，保持现状，等待下一次 changeDevice 事件再刷新
      return
    }
    runInAction(() => {
      this.devices = devices
      setMemStore('devices', devices)
    })
    if (!isEmpty(devices)) {
      if (!this.device) {
        this.selectDevice(devices[0])
      } else {
        const device = find(devices, ({ id }) => id === this.device!.id)
        if (!device) {
          this.selectDevice(devices[0])
        }
      }
    } else {
      if (this.device) {
        this.selectDevice(null)
      }
    }
  }
  private bindEvent() {
    main.on('changeDevice', this.refreshDevices)
    main.on('refreshDevices', this.refreshDevices)
    main.on('selectDevice', this.selectDevice)
    main.on('installPackage', async (path: string) => {
      if (this.device) {
        await installPackages(this.device.id, [path])
      }
    })
  }
}

export default new Store()
