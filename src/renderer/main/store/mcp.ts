import { action, makeObservable, observable, runInAction } from 'mobx'
import { IMcpConfigs, IMcpStatus } from 'common/types'

export class Mcp {
  running = false
  enabled = false
  lan = false
  port = 7788
  url = ''
  allowWrite = false
  toolCount = 0
  error = ''
  configs: IMcpConfigs | null = null

  constructor() {
    makeObservable(this, {
      running: observable,
      enabled: observable,
      lan: observable,
      port: observable,
      url: observable,
      allowWrite: observable,
      toolCount: observable,
      error: observable,
      configs: observable,
      apply: action,
    })

    this.bindEvent()
    this.init()
  }

  private bindEvent() {
    main.on('changeMcpStatus', (status: IMcpStatus) => this.apply(status))
  }

  apply(status: IMcpStatus) {
    if (!status) {
      return
    }
    this.running = status.running
    this.enabled = status.enabled
    this.lan = status.lan
    this.port = status.port
    this.url = status.url
    this.allowWrite = status.allowWrite
    this.toolCount = status.toolCount
    this.error = status.error || ''
  }

  private async init() {
    this.apply(await main.mcpGetStatus())
  }

  async setEnabled(enabled: boolean) {
    let status = await main.mcpSetEnabled(enabled)
    // 启动失败时回滚开关，避免"显示已开启但实际未监听"
    if (enabled && !status.running) {
      status = await main.mcpSetEnabled(false)
    }
    this.apply(status)

    return status
  }

  async setAllowWrite(allowWrite: boolean) {
    const status = await main.mcpSetAllowWrite(allowWrite)
    this.apply(status)

    return status
  }

  async setPort(port: number) {
    const status = await main.mcpSetPort(port)
    this.apply(status)

    return status
  }

  async setLan(lan: boolean) {
    const status = await main.mcpSetLan(lan)
    this.apply(status)

    return status
  }

  async getConfigs() {
    const configs = await main.mcpGetConfigs()
    runInAction(() => (this.configs = configs))

    return configs
  }

  async resetToken() {
    const configs = await main.mcpResetToken()
    runInAction(() => (this.configs = configs))

    return configs
  }
}
