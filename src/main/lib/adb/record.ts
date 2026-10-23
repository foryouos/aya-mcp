import { getDeviceStore, setDeviceStore, shell, spawnAdb } from './base'
import { deleteFile, statFile } from './file'

export interface IRecordingOptions {
  timeLimit?: number
  bitRate?: number
  size?: string
}

export interface IRecording {
  remotePath: string
  startedAt: number
  timeLimit: number
  bitRate: number
  size: string
}

export interface IRecordingStopResult {
  remotePath: string
  bytes: number
  durationMs: number
  stopped: boolean
}

export interface IRecordingStatus {
  recording: boolean
  pid: string
  remotePath: string
  bytes: number
  elapsedMs: number
  remainingMs: number
  timeLimit: number
}

// screenrecord 上限 180s，超出部分设备会自行截断
export const MAX_TIME_LIMIT = 180
export const DEFAULT_TIME_LIMIT = 180
export const DEFAULT_BIT_RATE = 8000000
export const REMOTE_DIR = '/data/local/tmp/aya'

const STORE_KEY = 'recording'

export function getRecording(deviceId: string): IRecording | null {
  return getDeviceStore(deviceId, STORE_KEY) || null
}

function setRecording(deviceId: string, value: IRecording | null) {
  setDeviceStore(deviceId, STORE_KEY, value)
}

export async function getScreenrecordPid(deviceId: string): Promise<string> {
  const output = await shell(deviceId, 'pidof screenrecord')

  return output.trim()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 停止后 mp4 需要一点时间写 moov，等进程退出 + 文件大小稳定
async function waitStableSize(deviceId: string, remotePath: string) {
  let last = -1
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    let size = 0
    try {
      const stat = await statFile(deviceId, remotePath)
      size = stat.size || 0
    } catch {
      return 0
    }
    if (size > 0 && size === last) {
      return size
    }
    last = size
  }

  return last < 0 ? 0 : last
}

export async function startRecording(
  deviceId: string,
  options: IRecordingOptions = {}
): Promise<IRecording> {
  const pid = await getScreenrecordPid(deviceId)
  if (pid) {
    throw new Error(`设备已在录屏中（pid ${pid}），请先停止`)
  }

  const timeLimit = Math.min(
    Math.max(Math.floor(Number(options.timeLimit) || DEFAULT_TIME_LIMIT), 1),
    MAX_TIME_LIMIT
  )
  const bitRate = Math.floor(Number(options.bitRate) || DEFAULT_BIT_RATE)
  const size = String(options.size || '').trim()

  await shell(deviceId, `mkdir -p ${REMOTE_DIR}`)

  const remotePath = `${REMOTE_DIR}/rec-${Date.now()}.mp4`
  const args = [
    'screenrecord',
    `--time-limit ${timeLimit}`,
    `--bit-rate ${bitRate}`,
  ]
  if (size) {
    args.push(`--size ${size}`)
  }
  args.push(remotePath)

  // nohup + & 让 screenrecord 脱离 adb shell 会话；用 CLI adb 启动以确保进程在
  // adb 连接关闭后不被 SIGHUP 杀掉（adbkit 的 shell 会在命令结束后关闭底层连接）
  const { code, stderr } = await spawnAdb(
    ['shell', `nohup ${args.join(' ')} </dev/null >/dev/null 2>&1 &`],
    deviceId
  )
  if (code !== 0) {
    throw new Error('screenrecord 启动命令失败：' + (stderr || `exit ${code}`))
  }

  const startedPid = await getScreenrecordPid(deviceId)
  if (!startedPid) {
    throw new Error('screenrecord 启动失败，请确认设备支持录屏')
  }

  const recording: IRecording = {
    remotePath,
    startedAt: Date.now(),
    timeLimit,
    bitRate,
    size,
  }
  setRecording(deviceId, recording)

  return recording
}

export async function stopRecording(
  deviceId: string
): Promise<IRecordingStopResult> {
  const recording = getRecording(deviceId)
  const pid = await getScreenrecordPid(deviceId)

  if (!recording && !pid) {
    throw new Error('当前没有进行中的录屏')
  }

  let stopped = false
  if (pid) {
    // SIGINT 才会让 screenrecord 正常收尾写入 moov，SIGKILL 会留下坏文件
    await shell(deviceId, `kill -2 ${pid}`)
    stopped = true
    for (let i = 0; i < 25; i++) {
      await sleep(200)
      if (!(await getScreenrecordPid(deviceId))) {
        break
      }
    }
  }

  if (!recording) {
    throw new Error('录屏已停止，但找不到输出文件（可能是应用重启导致状态丢失）')
  }

  const bytes = await waitStableSize(deviceId, recording.remotePath)
  setRecording(deviceId, null)

  return {
    remotePath: recording.remotePath,
    bytes,
    durationMs: Date.now() - recording.startedAt,
    stopped,
  }
}

export async function getRecordingStatus(
  deviceId: string
): Promise<IRecordingStatus> {
  const recording = getRecording(deviceId)
  const pid = await getScreenrecordPid(deviceId)

  let bytes = 0
  if (recording) {
    try {
      const stat = await statFile(deviceId, recording.remotePath)
      bytes = stat.size || 0
    } catch {
      bytes = 0
    }
  }

  const elapsedMs = recording ? Date.now() - recording.startedAt : 0
  const timeLimit = recording ? recording.timeLimit : 0

  return {
    recording: !!pid,
    pid,
    remotePath: recording ? recording.remotePath : '',
    bytes,
    elapsedMs,
    remainingMs: timeLimit ? Math.max(timeLimit * 1000 - elapsedMs, 0) : 0,
    timeLimit,
  }
}

export async function removeRecordingFile(deviceId: string, remotePath: string) {
  await deleteFile(deviceId, remotePath)
}
