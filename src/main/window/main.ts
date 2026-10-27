import { app, BrowserWindow, session, Tray, Menu, nativeImage } from 'electron'
import { getMainStore } from '../lib/store'
import { getOpenFileFromArgv, handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import * as screencast from './screencast'
import * as devices from './devices'
import * as updates from './updates'
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

// 获取托盘图标：必须读取独立的图标文件。
// 打包后 app.asar 内没有 build/icon.ico，且 nativeImage.createFromPath(exe)
// 无法从 exe 提取图标（返回空图），因此由 electron-builder 把图标复制到
// resources/tray.ico 与 resources/tray.png。
function getTrayIcon(): nativeImage {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'tray.png'),
      path.join(process.resourcesPath, 'tray.ico')
    )
  } else {
    candidates.push(
      path.resolve(app.getAppPath(), 'build', 'tray.png'),
      path.resolve(app.getAppPath(), 'build', 'icon.ico'),
      path.resolve(app.getAppPath(), 'build', 'icon.png')
    )
  }
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) {
        return img
      }
    } catch {
      logger.warn(`load tray icon failed: ${p}`)
    }
  }
  logger.warn('tray icon not found')
  return nativeImage.createEmpty()
}

// 创建系统托盘（仅 Windows）。关闭主窗口时隐藏到托盘，右键菜单可退出。
function setupTray() {
  if (tray || !isWindows) {
    return
  }
  const icon = getTrayIcon()
  try {
    tray = new Tray(icon)
  } catch (e) {
    logger.error(`create tray failed: ${e}`)
    return
  }
  // 图标文件缺失时退回 exe 内嵌图标，避免托盘区域空白
  if (icon.isEmpty()) {
    app
      .getFileIcon(app.getPath('exe'), { size: 'small' })
      .then((img) => {
        if (!img.isEmpty()) {
          tray?.setImage(img)
        }
      })
      .catch(() => {})
  }
  tray.setToolTip(app.getName())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示',
        click: () => win?.show(),
      },
      {
        label: '检查更新',
        click: () => updates.showWin(),
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
