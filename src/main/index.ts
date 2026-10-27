import { app } from 'electron'
import isWindows from 'licia/isWindows'
import pkg from '../../package.json'
import * as menu from './lib/menu'
import * as main from './window/main'
import * as updates from './window/updates'
import * as adb from './lib/adb'
import * as serial from './lib/serial'
import * as mcp from './lib/mcp'
import * as updater from 'share/main/lib/updater'
import * as terminal from 'share/main/window/terminal'
import * as window from 'share/main/lib/window'
import log from 'share/common/log'
import { getSettingsStore } from './lib/store'
import 'share/main'

const logger = log('main')
logger.info('start')

const settingsStore = getSettingsStore()
window.setDefaultOptions({
  customTitlebar: !settingsStore.get('useNativeTitlebar'),
})

// Windows 系统通知需要 AppUserModelID，否则托盘状态下的更新提醒不会弹出
if (isWindows) {
  app.setAppUserModelId(pkg.appId)
}

app.on('ready', () => {
  logger.info('app ready')

  terminal.init()
  adb.init()
  serial.init()
  mcp.init()
  updates.init()
  updater.init()
  main.showWin()
  menu.init()
  // 启动后在后台静默检查更新，有新版本时提醒
  updater.autoCheck()
})
