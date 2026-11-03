import { shell, getDeviceStore, setDeviceStore } from './base'
import toNum from 'licia/toNum'
import now from 'licia/now'
import filter from 'licia/filter'
import map from 'licia/map'
import isEmpty from 'licia/isEmpty'
import each from 'licia/each'
import contain from 'licia/contain'
import max from 'licia/max'
import last from 'licia/last'
import trim from 'licia/trim'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetFps } from 'common/types'
import startWith from 'licia/startWith'
import endWith from 'licia/endWith'

export const getFps: IpcGetFps = async function (deviceId, pkg) {
  let fps = 0

  const result: string = await shell(deviceId, 'dumpsys SurfaceFlinger')
  const match = result.match(/flips=(\d+)/)
  if (match) {
    const flips = toNum(match[1])
    const time = now()
    const lastFlips = getDeviceStore(deviceId, 'flips')
    if (lastFlips) {
      fps = Math.round(
        ((flips - lastFlips.flips) * 1000) / (time - lastFlips.time)
      )
    }
    setDeviceStore(deviceId, 'flips', {
      time,
      flips,
    })

    return fps
  } else {
    fps = await getFpsByLatency(deviceId, pkg)
  }

  return fps
}

async function getFpsByLatency(deviceId: string, pkg: string) {
  const fps = 0

  if (!pkg) {
    return fps
  }

  // SurfaceFlinger 的帧时间戳是 CLOCK_MONOTONIC，与 /proc/uptime 同基准。
  // 用它判断缓冲区里的最后一帧是不是「刚刚」渲染的
  const uptimeOut = await shell(deviceId, 'cat /proc/uptime', 5000).catch(
    () => ''
  )
  const deviceUptime = toNum(uptimeOut.split(' ')[0] || '0')

  const list = await shell(deviceId, 'dumpsys SurfaceFlinger --list')
  let layers = filter(list.split('\n'), (line) => contain(line, pkg))
  if (isEmpty(layers)) {
    return fps
  }

  layers = map(layers, (layer) => {
    if (startWith(layer, 'RequestedLayerState{')) {
      layer = layer.replace('RequestedLayerState{', '')
      const keys = [
        'parentId=',
        'relativeParentId=',
        'mirrorId=',
        'z=',
        'layerStack=',
      ]
      for (const key of keys) {
        if (contain(layer, key)) {
          layer = layer.slice(0, layer.indexOf(key) - 1)
          break
        }
      }
      if (endWith(layer, '}')) {
        layer = layer.slice(0, -1)
      }
    }
    return layer
  })

  layers = filter(layers, (layer) => {
    let result = true

    each(
      [
        'ActivityRecordInputSink',
        'Background for SurfaceView',
        'ActivityRecord',
        'Bounds for -',
      ],
      (content) => {
        if (contain(layer, content)) {
          result = false
        }
      }
    )

    return result
  })

  const latencies = await shell(
    deviceId,
    map(layers, (layer) => {
      return `dumpsys SurfaceFlinger --latency "${layer}"`
    })
  )
  const allFps = map(latencies, (latency) =>
    calcLatencyFps(latency, deviceUptime)
  )

  return max(...allFps)
}

/**
 * --latency 返回的是环形缓冲区（约 128 帧），里面混着几秒甚至几十分钟前的旧帧。
 * 直接拿首尾两个时间戳算平均，会被这些旧帧稀释成接近 0。
 * 这里只取末尾连续的一段（相邻间隔 < 200ms、跨度 ≤ 2s），
 * 并校验最后一帧确实是最近渲染的，桌面静止时如实返回 0。
 */
function calcLatencyFps(latency: string, deviceUptime: number): number {
  const timestamps: number[] = []
  each(trim(latency).split('\n'), (line) => {
    const match = line.match(/(\d+)\s+(\d+)\s+(\d+)/)
    if (!match) {
      return
    }
    // 第 2 列是实际呈现时间，0 表示该帧被丢弃
    const actual = toNum(match[2])
    if (actual > 0) {
      timestamps.push(actual / 1e9)
    }
  })

  if (timestamps.length < 2) {
    return 0
  }

  const end = last(timestamps) as number
  // 最后一帧不是最近渲染的，说明画面已经静止
  if (deviceUptime > 0 && deviceUptime - end > 3) {
    return 0
  }

  let start = timestamps.length - 1
  while (start > 0) {
    const gap = timestamps[start] - timestamps[start - 1]
    const span = end - timestamps[start - 1]
    if (gap > 0.2 || span > 2) {
      break
    }
    start--
  }

  const seconds = end - timestamps[start]
  if (seconds <= 0) {
    return 0
  }

  return Math.round((timestamps.length - 1 - start) / seconds)
}

export async function init() {
  handleEvent('getFps', getFps)
}
