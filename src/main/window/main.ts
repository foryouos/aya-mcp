import { app, BrowserWindow, session, Tray, Menu, nativeImage } from 'electron'
import { getMainStore } from '../lib/store'
import { getOpenFileFromArgv, handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import * as screencast from './screencast'
import * as devices from './devices'
import log from 'share/common/log'
import once from 'licia/once'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import isMac from 'licia/isMac'
import isWindows from 'licia/isWindows'
import endWith from 'licia/endWith'
import path from 'path'

const logger = log('mainWin')

const store = getMainStore()

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false

// 获取托盘图标：开发态用项目图标，打包后用 exe 图标（createFromPath 对 exe 在 dev 下常返回空图）
function getTrayIcon(): nativeImage {
  const candidates: string[] = []
  if (!app.isPackaged) {
    candidates.push(
      path.resolve(app.getAppPath(), 'build', 'icon.ico'),
      path.resolve(app.getAppPath(), 'build', 'icon.png')
    )
  }
  candidates.push(app.getPath('exe'))
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) {
      return img
    }
  }
  return nativeImage.createEmpty()
}

// 创建系统托盘（仅 Windows）。关闭主窗口时隐藏到托盘，右键菜单可退出。
function setupTray() {
  if (tray || !isWindows) {
    return
  }
  const icon = getTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip(app.getName())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示',
        click: () => win?.show(),
      },
      {
        type: 'separator',
      },
      {
        label: '退出',
        click: () => {
          isQuiting = true
          app.quit()
        },
      },
    ])
  )
  tray.on('double-click', () => win?.show())
}

export function showWin() {
  logger.info('show')

  if (win) {
    win.focus()
    return
  }

  init()
  initIpc()

  win = window.create({
    name: 'main',
    minWidth: 960,
    minHeight: 640,
    width: 960,
    height: 640,
    menu: true,
  })

  win.on('close', (e) => {
    const screencastWin = window.getWin('screencast')
    if (screencastWin && screencastWin.isVisible()) {
      e.preventDefault()
      win?.hide()
      return
    }
    // Windows 下点击关闭：最小化到系统托盘而非退出（类似微信）
    if (isWindows && !isQuiting) {
      e.preventDefault()
      win?.hide()
      return
    }
    app.quit()
  })

  setupTray()
  window.loadPage(win)
}

const init = once(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: ['ws://*/*'],
    },
    (details, callback) => {
      delete details.requestHeaders['Origin']
      callback({ requestHeaders: details.requestHeaders })
    }
  )
})

const initIpc = once(() => {
  handleEvent('setMainStore', <IpcSetStore>(
    ((name, val) => store.set(name, val))
  ))
  handleEvent('getMainStore', <IpcGetStore>((name) => store.get(name)))
  store.on('change', (name, val) => {
    window.sendAll('changeMainStore', name, val)
  })
  handleEvent('showScreencast', () => screencast.showWin())
  handleEvent('closeScreencast', () => screencast.closeWin())
  handleEvent('restartScreencast', () => {
    screencast.closeWin()
    screencast.showWin()
  })
  handleEvent('showDevices', () => devices.showWin())
  if (isMac) {
    app.on('open-file', (_, path) => {
      if (!endWith(path, '.apk')) {
        return
      }
      if (app.isReady()) {
        showWin()
        window.sendTo('main', 'installPackage', path)
      }
    })
  } else {
    app.on('second-instance', (_, argv) => {
      const apkPath = getOpenFileFromArgv(argv, '.apk')
      if (apkPath) {
        showWin()
        window.sendTo('main', 'installPackage', apkPath)
      }
    })
  }
})
