import sleep from 'licia/sleep'
import each from 'licia/each'
import map from 'licia/map'
import trim from 'licia/trim'
import toNum from 'licia/toNum'
import startWith from 'licia/startWith'
import { shell } from './base'
import { getDevicePlatform } from './platform'
import types from 'licia/types'
import average from 'licia/average'
import identity from 'licia/identity'
import stripNum from 'licia/stripNum'

const DEFAULT_PERIOD = 50

export async function getCpuLoads(
  deviceId: string,
  allCpus: any[],
  period = 0
) {
  const cpuLoads: number[] = []
  if (!period) {
    period = DEFAULT_PERIOD
  }

  return new Promise(function (resolve) {
    sleep(period).then(async () => {
      const newAllCpus = await getCpus(deviceId, false)
      each(allCpus, (cpu, idx) => {
        cpuLoads[idx] = calculateCpuLoad(cpu, newAllCpus[idx])
      })
      resolve(cpuLoads)
    })
  })
}

function calculateCpuLoad(lastCpu, cpu) {
  const lastTimes = lastCpu.times
  const times = cpu.times
  const lastLoad =
    lastTimes.user +
    lastTimes.sys +
    lastTimes.nice +
    lastTimes.irq +
    lastTimes.iowait +
    lastTimes.softirq
  const lastTick = lastLoad + lastTimes.idle
  const load =
    times.user +
    times.sys +
    times.nice +
    times.irq +
    times.iowait +
    times.softirq
  const tick = load + times.idle

  return (load - lastLoad) / (tick - lastTick)
}

export async function getCpus(deviceId: string, speed = true) {
  const result: string = await shell(deviceId, 'cat /proc/stat')
  const lines = result.split('\n')
  const cpus: any[] = []

  each(lines, (line) => {
    line = trim(line)
    if (!startWith(line, 'cpu')) {
      return
    }

    const parts = line.split(/\s+/)
    if (parts[0] === 'cpu') {
      return
    }

    const cpu: any = {}
    cpu.times = {
      user: toNum(parts[1]),
      nice: toNum(parts[2]),
      sys: toNum(parts[3]),
      idle: toNum(parts[4]),
      iowait: toNum(parts[5]),
      irq: toNum(parts[6]),
      softirq: toNum(parts[7]),
    }

    cpus.push(cpu)
  })

  if (speed) {
    const freqs = await shell(
      deviceId,
      map(cpus, (cpu, idx) => {
        return `cat /sys/devices/system/cpu/cpu${idx}/cpufreq/scaling_cur_freq`
      })
    )
    const speeds: number[] = []
    each(freqs, (line) => {
      line = trim(line)
      if (!line) {
        return
      }
      speeds.push(Math.floor(toNum(line) / 1000))
    })

    each(cpus, (cpu, idx) => {
      cpu.speed = speeds[idx]
    })
  }

  return cpus
}

const regTemperature =
  /Temperature\{mValue=([\d.]+),\s*mType=(\d+),\s*mName=(\w+)/
export async function getCpuTemperature(deviceId: string) {
  const platform = await getDevicePlatform(deviceId)
  if (platform.platform === 'linux') {
    return getLinuxTemperature(deviceId)
  }

  const thermal = await shell(deviceId, 'dumpsys thermalservice')
  const lines = thermal.split('\n')

  const cpuTemperatures: types.PlainObj<number> = {}

  for (let i = 0, len = lines.length; i < len; i++) {
    const line = lines[i]
    const match = line.match(regTemperature)
    if (match) {
      const name = match[3]
      const value = toNum(match[1])
      if (startWith(name, 'CPU')) {
        cpuTemperatures[name] = value
      }
    }
  }

  return stripNum(average(...map(cpuTemperatures, identity)), 3)
}

interface IThermalZone {
  type: string
  temp: number
}

// Linux 主板用 /sys/class/thermal：RK3568 上是 soc-thermal + gpu-thermal，
// 优先取 CPU/SOC 相关 zone，没有就取全部 zone 的均值
async function getLinuxTemperature(deviceId: string): Promise<number> {
  const out = await shell(
    deviceId,
    'for z in /sys/class/thermal/thermal_zone*; do echo $z $(cat $z/type 2>/dev/null) $(cat $z/temp 2>/dev/null); done'
  )
  const zones: IThermalZone[] = []

  each(out.split('\n'), (line) => {
    line = trim(line)
    if (!line) {
      return
    }
    const parts = line.split(/\s+/)
    if (parts.length < 3) {
      return
    }
    const temp = toNum(parts[2]) / 1000
    if (!temp) {
      return
    }
    zones.push({ type: parts[1], temp })
  })

  if (!zones.length) {
    return 0
  }

  const cpuZones = zones.filter((zone) =>
    /cpu|soc|cluster|core|big|little|ap/i.test(zone.type)
  )
  const picked = cpuZones.length ? cpuZones : zones

  return stripNum(average(...picked.map((zone) => zone.temp)), 3)
}
