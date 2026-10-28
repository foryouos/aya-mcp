import { Client } from '@devicefarmer/adbkit'
import { shell } from './base'
import { assertAndroid, getDevicePlatform } from './platform'
import singleton from 'licia/singleton'
import map from 'licia/map'
import trim from 'licia/trim'
import contain from 'licia/contain'
import { handleEvent } from 'share/main/lib/util'
import {
  IpcClearPackage,
  IpcDisablePackage,
  IpcEnablePackage,
  IpcGetPackages,
  IpcGetTopPackage,
  IpcInstallPackage,
  IpcStartPackage,
  IpcStopPackage,
  IpcUninstallPackage,
} from 'common/types'

let client: Client

const getCurrentUser = singleton(async (deviceId: string) => {
  const result = await shell(deviceId, 'am get-current-user')
  return parseInt(result, 10)
})

export const getPackages = singleton(<IpcGetPackages>(async (
  deviceId,
  system = true
) => {
  // Linux 主板没有 pm：返回空列表，让进程/文件面板照常工作
  const platform = await getDevicePlatform(deviceId)
  if (platform.platform !== 'android') {
    return []
  }

  const result: string = await shell(
    deviceId,
    `pm list packages${system ? '' : ' -3'} --user ${await getCurrentUser(
      deviceId
    )}`
  )

  return map(trim(result).split('\n'), (line) => line.slice(8))
}))

export const stopPackage: IpcStopPackage = async function (deviceId, pkg) {
  await assertAndroid(deviceId, '应用管理（am force-stop）')
  await shell(deviceId, `am force-stop ${pkg}`)
}

export const clearPackage: IpcClearPackage = async function (deviceId, pkg) {
  await assertAndroid(deviceId, '应用管理（pm clear）')
  const device = await client.getDevice(deviceId)
  await device.clear(pkg)
}

export const startPackage: IpcStartPackage = async function (deviceId, pkg) {
  await assertAndroid(deviceId, '应用管理（am start）')
  const component = await getMainComponent(deviceId, pkg)
  const device = await client.getDevice(deviceId)
  await device.startActivity({
    component,
  })
}

export const installPackage: IpcInstallPackage = async function (
  deviceId,
  apkPath
) {
  await assertAndroid(deviceId, 'APK 安装（pm install）')
  const device = await client.getDevice(deviceId)
  await device.install(apkPath)
}

export const uninstallPackage: IpcUninstallPackage = async function (
  deviceId,
  pkg
) {
  await assertAndroid(deviceId, '应用卸载（pm uninstall）')
  const device = await client.getDevice(deviceId)
  await device.uninstall(pkg)
}

async function getMainComponent(deviceId: string, pkg: string) {
  const result = await shell(
    deviceId,
    `dumpsys package ${pkg} | grep -A 1 MAIN`
  )
  const lines = result.split('\n')
  for (let i = 0, len = lines.length; i < len; i++) {
    const line = trim(lines[i])
    if (contain(line, `${pkg}/`)) {
      return line.substring(line.indexOf(`${pkg}/`), line.indexOf(' filter'))
    }
  }

  throw new Error('Failed to get main activity')
}

export const getTopPackage = singleton(<IpcGetTopPackage>(
  async function (deviceId) {
    // Linux 主板没有 Activity 概念，返回空值让性能页/WebView 页自动跳过
    const platform = await getDevicePlatform(deviceId)
    if (platform.platform !== 'android') {
      return { name: '', pid: 0 }
    }

    const topActivity = await shell(deviceId, 'dumpsys activity')
    const lines = topActivity.split('\n')
    let line = ''
    for (let i = 0, len = lines.length; i < len; i++) {
      if (contain(lines[i], 'top-activity')) {
        line = trim(lines[i])
        break
      }
    }

    if (!line) {
      return {
        name: '',
        pid: 0,
      }
    }

    let parts = line.split(/\s+/)
    parts = parts[parts.length - 2].split(':')
    const pid = parseInt(parts[0], 10)
    let name = parts[1]
    if (contain(name, '/')) {
      name = name.split('/')[0]
    }

    return {
      name,
      pid,
    }
  }
))

export const disablePackage: IpcDisablePackage = async function (
  deviceId,
  pkg
) {
  await assertAndroid(deviceId, '应用管理（pm disable-user）')
  await shell(deviceId, `pm disable-user ${pkg}`)
}

export const enablePackage: IpcEnablePackage = async function (deviceId, pkg) {
  await assertAndroid(deviceId, '应用管理（pm enable）')
  await shell(deviceId, `pm enable ${pkg}`)
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackages', getPackages)
  handleEvent('stopPackage', stopPackage)
  handleEvent('startPackage', startPackage)
  handleEvent('installPackage', installPackage)
  handleEvent('uninstallPackage', uninstallPackage)
  handleEvent('getTopPackage', getTopPackage)
  handleEvent('clearPackage', clearPackage)
  handleEvent('disablePackage', disablePackage)
  handleEvent('enablePackage', enablePackage)
}
