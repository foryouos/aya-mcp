import { BrowserWindow } from 'electron'
import * as window from 'share/main/lib/window'
import { getScreencastStore } from '../lib/store'
import once from 'licia/once'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import {
  IpcSetScreencastAlwaysOnTop,
  IpcSetScreencastDevices,
  IpcSetScreencastLayout,
  ScreencastLayout,
} from 'common/types'
import { stopActiveScrcpy } from '../lib/adb/scrcpy'

const store = getScreencastStore()

let win: BrowserWindow | null = null
// renderer 同步过来的当前投屏设备列表，MCP 的增删与查询都基于它
let currentDeviceIds: string[] = []

// 兼容旧的单设备调用（string）与新的多设备调用（string[]）
function normalizeIds(deviceIds?: string | string[]) {
  if (!deviceIds) {
    return []
  }
  const list = Array.isArray(deviceIds) ? deviceIds : [deviceIds]
  const ret: string[] = []
  for (let i = 0, len = list.length; i < len; i++) {
    const id = list[i]
    if (typeof id === 'string' && id && ret.indexOf(id) < 0) {
      ret.push(id)
    }
  }
  return ret
}

/**
 * 单窗口多画面：所有要投屏的设备共用同一个窗口，窗口内部由 renderer
 * 用网格布局并排显示。窗口已存在时不再短路返回，而是把新的设备列表
 * 推给 renderer 同步，否则第二台设备会被静默忽略。
 */
export function showWin(deviceIds?: string | string[]) {
  const ids = normalizeIds(deviceIds)

  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    if (ids.length) {
      window.sendTo('screencast', 'syncScreencastDevices', ids)
    }
    return
  }

  initIpc()

  // 多设备时窗口按设备数横向铺开，竖屏手机并排看才有意义
  const count = Math.max(ids.length, 1)
  const next = window.create({
    name: 'screencast',
    minWidth: 430,
    minHeight: 500,
    width: count <= 1 ? 430 : count === 2 ? 860 : 1280,
    height: count >= 4 ? 780 : 640,
  })
  win = next

  next.on('close', () => {
    if (win === next) {
      win = null
    }
    currentDeviceIds = []
    // 多设备时这里必须停掉全部会话，只停一台会泄漏其余设备端进程
    stopActiveScrcpy()
    const mainWin = window.getWin('main')
    if (mainWin) {
      mainWin.show()
    }
  })
  next.on('closed', () => {
    if (win === next) {
      win = null
    }
    // renderer 可能已被 destroy，来不及发 stopScrcpy
    stopActiveScrcpy()
  })

  // deviceIds 可选：MCP 调用指定设备时，让投屏窗口固定这些设备而不是跟随主窗口选中项
  window.loadPage(next, {
    page: 'screencast',
    ...(ids.length ? { deviceIds: ids.join(',') } : {}),
  })
  // renderer 起来之前先记下目标，MCP 紧接着查询也能拿到正确结果
  currentDeviceIds = ids
}

export function isShown() {
  return !!win && !win.isDestroyed()
}

export function getDeviceIds() {
  return currentDeviceIds.slice()
}

/** 让窗口把某一路放大；空字符串表示取消聚焦 */
export function focusDevice(deviceId: string) {
  if (!isShown()) {
    return false
  }
  window.sendTo('screencast', 'setScreencastFocus', deviceId)
  return true
}

export function applyLayout(layout: ScreencastLayout) {
  if (!isShown()) {
    return false
  }
  store.set('layout', layout)
  window.sendTo('screencast', 'applyScreencastLayout', layout)
  return true
}

export function closeWin() {
  const target = win
  win = null
  currentDeviceIds = []
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
  handleEvent('setScreencastLayout', <IpcSetScreencastLayout>((
    layout: ScreencastLayout
  ) => {
    store.set('layout', layout)
  }))
  handleEvent('setScreencastDevices', <IpcSetScreencastDevices>((
    deviceIds: string[]
  ) => {
    currentDeviceIds = Array.isArray(deviceIds) ? deviceIds.slice() : []
  }))
})
