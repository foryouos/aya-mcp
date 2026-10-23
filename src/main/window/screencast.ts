import { BrowserWindow } from 'electron'
import * as window from 'share/main/lib/window'
import { getScreencastStore } from '../lib/store'
import once from 'licia/once'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import { IpcSetScreencastAlwaysOnTop } from 'common/types'

const store = getScreencastStore()

let win: BrowserWindow | null = null

export function showWin() {
  if (win) {
    win.focus()
    return
  }

  initIpc()

  const next = window.create({
    name: 'screencast',
    minWidth: 430,
    minHeight: 640,
    width: 430,
    height: 640,
  })
  win = next

  next.on('close', () => {
    if (win === next) {
      win = null
    }
    const mainWin = window.getWin('main')
    if (mainWin) {
      mainWin.show()
    }
  })
  next.on('closed', () => {
    if (win === next) {
      win = null
    }
  })

  window.loadPage(next, { page: 'screencast' })
}

export function isShown() {
  return !!win && !win.isDestroyed()
}

export function closeWin() {
  const target = win
  win = null
  if (!target || target.isDestroyed()) {
    return
  }

  target.destroy()

  const mainWin = window.getWin('main')
  if (mainWin) {
    mainWin.show()
  }
}

const initIpc = once(() => {
  handleEvent('setScreencastStore', <IpcSetStore>(
    ((name, val) => store.set(name, val))
  ))
  handleEvent('getScreencastStore', <IpcGetStore>((name) => store.get(name)))
  handleEvent('setScreencastAlwaysOnTop', <IpcSetScreencastAlwaysOnTop>((
    alwaysOnTop
  ) => {
    if (win) {
      win.setAlwaysOnTop(alwaysOnTop)
    }
  }))
})
