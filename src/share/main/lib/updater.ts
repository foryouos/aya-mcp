import { autoUpdater } from 'electron-updater'
import * as window from './window'

autoUpdater.autoDownload = false

export function checkUpdate() {
  autoUpdater.checkForUpdates()
}

export function init() {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'foryouos',
    repo: 'aya-mcp',
  })

  autoUpdater.on('update-not-available', () => {
    window.sendTo('main', 'updateNotAvailable')
  })
  autoUpdater.on('update-available', () => {
    window.sendTo('main', 'updateAvailable')
  })
  autoUpdater.on('error', () => {
    window.sendTo('main', 'updateError')
  })
}
