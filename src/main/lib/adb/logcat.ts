import Emitter from 'licia/Emitter'
import types from 'licia/types'
import { Client } from '@devicefarmer/adbkit'
import { getDeviceStore, getPidNames, setDeviceStore, shell } from './base'
import { getDevicePlatform } from './platform'
import uniqId from 'licia/uniqId'
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import {
  ILinuxLogLine,
  LinuxLogSource,
  parseLinuxLog,
  pickLogSource,
  snapshotCommand,
} from '../log/linux'
import {
  IpcCloseLogcat,
  IpcOpenLogcat,
  IpcPauseLogcat,
  IpcResumeLogcat,
} from 'common/types'

let client: Client

const logger = log('logcat')

// 轮询间隔与每次拉取的行数：1.5s 一次足以做实时跟随，又不会把 adb 通道压满
const POLL_INTERVAL = 1500
const POLL_LINES = 80

// Android priority: V2 D3 I4 W5 E6 F7，面板按数字渲染级别字母
const PANEL_PRIORITY: Record<ILinuxLogLine['level'], number> = {
  V: 2,
  D: 3,
  I: 4,
  W: 5,
  E: 6,
  F: 7,
}

function toPanelEntry(entry: ILinuxLogLine) {
  return {
    date: entry.date,
    pid: entry.pid,
    tid: 0,
    priority: PANEL_PRIORITY[entry.level],
    tag: entry.tag,
    package: entry.tag,
    message: entry.message,
  }
}

class Logcat extends Emitter {
  private reader: any
  private paused = false
  constructor(reader: any) {
    super()

    this.reader = reader
  }
  async init(deviceId: string) {
    const { reader } = this

    reader.on('entry', async (entry) => {
      if (this.paused) {
        return
      }
      if (entry.pid != 0) {
        let pidNames = getDeviceStore(deviceId, 'pidNames')
        if (!pidNames || !pidNames[entry.pid]) {
          pidNames = await getPidNames(deviceId)
          setDeviceStore(deviceId, 'pidNames', pidNames)
        }
        entry.package = pidNames[entry.pid] || `pid-${entry.pid}`
      }
      this.emit('entry', entry)
    })
  }
  close() {
    this.reader.end()
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
}

/**
 * Linux 主板日志：journalctl/dmesg 的 -f / -w 在 adb 的非 tty 通道下不会吐出任何数据
 * （实测 journalctl -f 通过 adb shell 永远收不到字节），所以用短轮询 + cursor 去重，
 * 效果与跟随一致。输出结构与 Android 的 logcat entry 对齐。
 */
class LinuxLogcat extends Emitter {
  private deviceId: string
  private source: LinuxLogSource
  private paused = false
  private closed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private seen = new Set<string>()
  private polling = false

  constructor(deviceId: string, source: LinuxLogSource) {
    super()

    this.deviceId = deviceId
    this.source = source
  }

  async start() {
    await this.poll(300)
    this.timer = setInterval(() => {
      this.poll(POLL_LINES)
    }, POLL_INTERVAL)
  }

  private async poll(lines: number) {
    if (this.closed || this.paused || this.polling) {
      return
    }
    this.polling = true
    try {
      const raw = await shell(
        this.deviceId,
        snapshotCommand(this.source, lines)
      )
      if (this.closed) {
        return
      }

      const fresh: ILinuxLogLine[] = []
      parseLinuxLog(raw, this.source).forEach((entry) => {
        const key = entry.cursor || `${entry.date.getTime()}|${entry.message}`
        if (this.seen.has(key)) {
          return
        }
        this.seen.add(key)
        fresh.push(entry)
      })

      // 防止 Set 无限增长：只保留最近 2000 条的去重键
      if (this.seen.size > 2000) {
        const drop = this.seen.size - 2000
        let i = 0
        for (const key of this.seen) {
          if (i++ >= drop) {
            break
          }
          this.seen.delete(key)
        }
      }

      if (this.closed || this.paused) {
        return
      }
      fresh.forEach((entry) => this.emit('entry', toPanelEntry(entry)))
    } catch (err) {
      logger.error(`linux log poll failed: ${(err as Error).message}`)
    } finally {
      this.polling = false
    }
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  close() {
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

const logcats: types.PlainObj<any> = {}

const openLogcat: IpcOpenLogcat = async function (deviceId) {
  const logcatId = uniqId('logcat')
  const platform = await getDevicePlatform(deviceId)

  if (platform.platform === 'linux') {
    const linuxLog = new LinuxLogcat(deviceId, pickLogSource(platform))
    logcats[logcatId] = linuxLog
    linuxLog.on('entry', (entry) => {
      window.sendTo('main', 'logcatEntry', logcatId, entry)
    })
    // 历史日志异步补发，不阻塞 IPC 返回
    linuxLog.start()
    return logcatId
  }

  const device = await client.getDevice(deviceId)
  const reader = await device.openLogcat({
    clear: true,
  })
  const logcat = new Logcat(reader)
  await logcat.init(deviceId)
  logcat.on('entry', (entry) => {
    window.sendTo('main', 'logcatEntry', logcatId, entry)
  })
  logcats[logcatId] = logcat

  return logcatId
}

const pauseLogcat: IpcPauseLogcat = async function (logcatId) {
  logcats[logcatId].pause()
}

const resumeLogcat: IpcResumeLogcat = async function (logcatId) {
  logcats[logcatId].resume()
}

const closeLogcat: IpcCloseLogcat = async function (logcatId) {
  logcats[logcatId].close()
  delete logcats[logcatId]
}

export function init(c: Client) {
  client = c

  handleEvent('openLogcat', openLogcat)
  handleEvent('closeLogcat', closeLogcat)
  handleEvent('pauseLogcat', pauseLogcat)
  handleEvent('resumeLogcat', resumeLogcat)
}
