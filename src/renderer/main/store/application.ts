import { makeObservable, observable, runInAction } from 'mobx'
import extend from 'licia/extend'

// 一级视图：应用列表 / 服务列表
export type ApplicationView = 'package' | 'service'
// 服务视图里的二级分组：系统服务 / 应用服务
export type ServiceGroup = 'system' | 'app'

export class Application {
  itemSize = 48
  sysPackage = true
  listView = false
  dataGridColumns: any[] = []
  view: ApplicationView = 'package'
  serviceGroup: ServiceGroup = 'system'
  constructor() {
    makeObservable(this, {
      itemSize: observable,
      sysPackage: observable,
      listView: observable,
      view: observable,
      serviceGroup: observable,
    })

    this.init()
  }
  async init() {
    const application = await main.getMainStore('application')
    if (application) {
      runInAction(() => extend(this, application))
    }
  }
  async set(key: string, val: any) {
    runInAction(() => {
      this[key] = val
    })
    await main.setMainStore('application', {
      itemSize: this.itemSize,
      sysPackage: this.sysPackage,
      listView: this.listView,
      dataGridColumns: this.dataGridColumns,
      view: this.view,
      serviceGroup: this.serviceGroup,
    })
  }
}
