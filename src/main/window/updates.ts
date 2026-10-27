import { BrowserWindow } from 'electron'
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'

let win: BrowserWindow | null = null

export function showWin() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore()
    }
    win.show()
    win.focus()
    return
  }

  win = window.create({
    name: 'updates',
    resizable: false,
    minWidth: 400,
    minHeight: 360,
    width: 400,
    height: 360,
  })

  win.on('close', () => {
    win?.destroy()
    win = null
  })

  window.loadPage(win, { page: 'updates' })
}

export function init() {
  handleEvent('showUpdateWindow', () => showWin())
}
