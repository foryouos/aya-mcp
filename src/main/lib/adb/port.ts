import { Client, Forward, Reverse } from '@devicefarmer/adbkit'
import {
  IpcForward,
  IpcListForwards,
  IpcListReverses,
  IpcReverse,
} from 'common/types'
import map from 'licia/map'
import { handleEvent } from 'share/main/lib/util'
import { spawnAdb } from './base'

let client: Client

export const listForwards: IpcListForwards = async function (deviceId) {
  const device = await client.getDevice(deviceId)
  const forwards = await device.listForwards()
  return map(forwards, (forward: Forward) => {
    return {
      local: forward.local,
      remote: forward.remote,
    }
  })
}

export const forward: IpcForward = async function (deviceId, local, remote) {
  const device = await client.getDevice(deviceId)
  await device.forward(local, remote)
}

export const listReverses: IpcListReverses = async function (deviceId) {
  const device = await client.getDevice(deviceId)
  const reverses = await device.listReverses()
  return map(reverses, (reverse: Reverse) => {
    return {
      local: reverse.local,
      remote: reverse.remote,
    }
  })
}

export const reverse: IpcReverse = async function (deviceId, remote, local) {
  const device = await client.getDevice(deviceId)
  await device.reverse(remote, local)
}

// adbkit 没有提供移除接口，走 adb 可执行文件的 host 命令
async function runAdb(args: string[], action: string) {
  const { code, stdout, stderr } = await spawnAdb(args)
  if (code !== 0) {
    throw new Error(`${action}失败：${stderr || stdout || `exit ${code}`}`)
  }

  return (stdout || stderr || '').trim()
}

export async function removeForward(target: string) {
  return runAdb(
    target === 'all'
      ? ['forward', '--remove-all']
      : ['forward', '--remove', target],
    target === 'all' ? '清空本机端口转发' : `移除端口转发 ${target}`
  )
}

export async function removeReverse(target: string) {
  return runAdb(
    target === 'all'
      ? ['reverse', '--remove-all']
      : ['reverse', '--remove', target],
    target === 'all' ? '清空设备反向转发' : `移除反向转发 ${target}`
  )
}

export function init(c: Client) {
  client = c

  handleEvent('listForwards', listForwards)
  handleEvent('listReverses', listReverses)
  handleEvent('forward', forward)
  handleEvent('reverse', reverse)
}
