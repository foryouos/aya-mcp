import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { ensureDeviceDir, getDeviceStore, setDeviceStore } from './base'
import log from 'share/common/log'
import { IpcStartScrcpy, IpcStopScrcpy } from 'common/types'

const logger = log('scrcpy')

let client: Client
// 当前正在投屏的设备集合。多设备同屏投屏时会有多路会话并存，
// 窗口被强制销毁时要把这些设备端进程全部清理掉，否则会残留 N-1 个
const activeDeviceIds = new Set<string>()

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

    // 设备离线时后面的 shell / push 都会变成协议层报错，先给出明确提示
    const devices = await client.listDevices()
    const target = devices.find((item) => item.id === this.deviceId)
    if (!target || target.type !== 'device') {
      throw new Error(`设备 ${this.deviceId} 不在线`)
    }

    // 目录可能是在 root 模式下创建的，普通 shell 写不进去，
    // 不修复的话 push 会直接报 Permission denied
    if (!(await ensureDeviceDir(this.deviceId))) {
      throw new Error(
        '设备端目录 /data/local/tmp/aya 不可写：请执行 adb root 后重试，或手动删除该目录'
      )
    }

    await this.push()

    logger.info('start', args)

    const device = client.getDevice(this.deviceId)
    const socket = await device.shell(
      `CLASSPATH=/data/local/tmp/aya/scrcpy.jar app_process /system/bin com.genymobile.scrcpy.Server 3.1 ${args.join(
        ' '
      )}`
    )
    this.socket = socket
    activeDeviceIds.add(this.deviceId)
    const release = () => {
      // 旧 socket 的迟到事件不能把新启动的会话状态清掉
      if (this.socket === socket) {
        this.socket = null
        activeDeviceIds.delete(this.deviceId)
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
    activeDeviceIds.delete(this.deviceId)
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
    try {
      await device.push(
        resolveResources('scrcpy.jar'),
        '/data/local/tmp/aya/scrcpy.jar'
      )
    } catch (err) {
      throw new Error(
        `推送 scrcpy 组件失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
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
 * 不传 deviceId 时清理全部活跃会话，多设备投屏关窗必须走这条路径。
 */
export function stopActiveScrcpy(deviceId?: string) {
  const ids = deviceId ? [deviceId] : Array.from(activeDeviceIds)
  for (let i = 0, len = ids.length; i < len; i++) {
    const id = ids[i]
    activeDeviceIds.delete(id)
    const scrcpyClient = getDeviceStore(id, 'scrcpyClient')
    if (scrcpyClient) {
      scrcpyClient.stop().catch(() => {})
    }
  }
}

export async function init(c: Client) {
  client = c

  handleEvent('startScrcpy', startScrcpy)
  handleEvent('stopScrcpy', stopScrcpy)
}
