import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { getDeviceStore, setDeviceStore } from './base'
import log from 'share/common/log'
import { IpcStartScrcpy, IpcStopScrcpy } from 'common/types'

const logger = log('scrcpy')

let client: Client
// 当前正在投屏的设备，用于窗口被强制销毁时兜底清理设备端进程
let activeDeviceId = ''

class ScrcpyClient {
  private deviceId = ''
  // 设备端 scrcpy 是通过 adb shell 通道启动的，
  // 必须持有这条通道并在关闭投屏时销毁，否则每开关一次就泄漏一个 socket
  private socket: any = null
  constructor(deviceId: string) {
    this.deviceId = deviceId
  }
  async start(args: string[]) {
    await this.stop()
    await this.push()

    logger.info('start', args)

    const device = client.getDevice(this.deviceId)
    const socket = await device.shell(
      `CLASSPATH=/data/local/tmp/aya/scrcpy.jar app_process /system/bin com.genymobile.scrcpy.Server 3.1 ${args.join(
        ' '
      )}`
    )
    this.socket = socket
    activeDeviceId = this.deviceId
    const release = () => {
      // 旧 socket 的迟到事件不能把新启动的会话状态清掉
      if (this.socket === socket) {
        this.socket = null
        if (activeDeviceId === this.deviceId) {
          activeDeviceId = ''
        }
      }
    }
    socket.on('readable', () => {
      const data = socket.read()
      if (data) {
        logger.info(data.toString())
      }
    })
    socket.on('close', release)
    socket.on('end', release)
    socket.on('error', release)
  }
  async stop() {
    const socket = this.socket
    this.socket = null
    if (activeDeviceId === this.deviceId) {
      activeDeviceId = ''
    }
    if (!socket) {
      return
    }

    logger.info('stop')
    try {
      if (typeof socket.destroy === 'function') {
        socket.destroy()
      } else if (typeof socket.end === 'function') {
        socket.end()
      }
    } catch {
      // ignore
    }
    // 给设备端进程一点时间释放 localabstract 端口，避免重启时绑定失败
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  async push() {
    logger.info('push')

    const device = client.getDevice(this.deviceId)
    await device.push(
      resolveResources('scrcpy.jar'),
      '/data/local/tmp/aya/scrcpy.jar'
    )
  }
}

async function getScrcpyClient(deviceId: string): Promise<ScrcpyClient> {
  let scrcpyClient = getDeviceStore(deviceId, 'scrcpyClient')
  if (!scrcpyClient) {
    scrcpyClient = new ScrcpyClient(deviceId)
    setDeviceStore(deviceId, 'scrcpyClient', scrcpyClient)
  }
  return scrcpyClient
}

const startScrcpy: IpcStartScrcpy = async function (deviceId, args) {
  const scrcpyClient = await getScrcpyClient(deviceId)
  await scrcpyClient.start(args)
}

const stopScrcpy: IpcStopScrcpy = async function (deviceId) {
  const scrcpyClient = getDeviceStore(deviceId, 'scrcpyClient')
  if (scrcpyClient) {
    await scrcpyClient.stop()
  }
}

/**
 * 投屏窗口被强制销毁时（renderer 来不及发 IPC），由主进程兜底关闭设备端进程。
 */
export function stopActiveScrcpy() {
  if (!activeDeviceId) {
    return
  }
  const deviceId = activeDeviceId
  activeDeviceId = ''
  const scrcpyClient = getDeviceStore(deviceId, 'scrcpyClient')
  if (scrcpyClient) {
    scrcpyClient.stop().catch(() => {})
  }
}

export async function init(c: Client) {
  client = c

  handleEvent('startScrcpy', startScrcpy)
  handleEvent('stopScrcpy', stopScrcpy)
}
