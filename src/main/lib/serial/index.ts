import fs from 'fs-extra'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app, dialog } from 'electron'
import { SerialPort } from 'serialport'
import dateFormat from 'licia/dateFormat'
import uniqId from 'licia/uniqId'
import toNum from 'licia/toNum'
import { handleEvent, getUserDataPath } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import log from 'share/common/log'
import { getSettingsStore } from '../store'
import {
  ISerialData,
  ISerialLine,
  ISerialPortInfo,
  ISerialQuery,
  ISerialQueryResult,
  ISerialStatus,
  SerialSource,
} from 'common/types'

const logger = log('main:serial')

const DEFAULT_MAX_LINES = 200000
// 单个日志文件上限，超过后自动新建下一个文件，避免无限膨胀
const MAX_LOG_FILE_SIZE = 512 * 1024 * 1024
const EMIT_INTERVAL = 120
const MAX_LINE_LENGTH = 8192

// 串口日志按阶段划分：引导(loader) -> 内核(kernel) -> Android
// 阶段默认单向推进；命中强引导标记时回到 loader，兼容板子重启后再次进入引导
// 内核日志几乎都带 printk 前缀 [    1.672163][    T0]，以此作为内核的强特征
const LOADER_PATTERN =
  /^[\s\0]*DDR[ \d]|^U-Boot (SPL|20\d\d\.\d+)|^Boot ROM|^SPL: |^## |^Loading (kernel|dtb|ramdisk|kernel image)|^Starting kernel|^Total: \d+\.\d+\/\d+\.\d+ ms|^Adding bank:|^vp\d+, plane_mask|^Trying to boot from|^LPDDR\d|^change to F\d|^sfc cmd=|^unknown raw ID|^Hit any key|^fastboot|^(In|Out|Err|MMC|SF|Net|Model): /i
const KERNEL_START_PATTERN =
  /Booting Linux|Linux version|Uncompressing Linux|Kernel command line|Freeing unused kernel memory|Kernel panic|Call trace:|Unable to handle kernel|^\[\s*\d+\.\d+\]|^<\d+>/i
const ANDROID_LOG_PATTERN =
  /^-{5,}\s*beginning of|^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEF]\s/
const ANDROID_DAEMON_PATTERN =
  /^init:\s|zygote|system_server|servicemanager|surfaceflinger|ActivityManager|WindowManager|PackageManager/i
// Android 控制台 shell 提示符，如 console:/ $ 、console:/ $ echo 1 ，
// 说明系统已启动完成；据此避免已开机的板子被误判成还在引导
const ANDROID_SHELL_PATTERN = /^\s*console:[^$#]{0,60}[$#](\s|$)/

let port: SerialPort | null = null
let sessionId = ''
let startedAt = 0
let currentPath = ''
let currentBaudRate = 115200
let paused = false
let lastError = ''

let lines: ISerialLine[] = []
let head = 0
let seq = 0
let dropped = 0
let bytes = 0
let maxLines = DEFAULT_MAX_LINES

let decoder = new StringDecoder('utf8')
let pendingText = ''
// 初始阶段未知：连上时板子可能已经开机，先落到 other，等特征行出现再判定
let stage: SerialSource = 'other'

let spool: fs.WriteStream | null = null
let spoolBytes = 0
let logFile = ''
let logFiles: string[] = []

let pendingEmit: ISerialLine[] = []
let emitTimer: NodeJS.Timeout | null = null

// 自动波特率探测状态：探测期间不落盘、不解析，只收集原始字节用于打分
let detecting = false
let detectChunks: Buffer[] = []
let detectSize = 0

// 主板调试口只有三个常用速率，探测也只用它们，避免长时间扫描
const DETECT_RATES = [1500000, 921600, 115200]

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bufferedLines() {
  return lines.length - head
}

function classify(text: string): SerialSource {
  // 强引导特征优先判定，并按行内容把阶段拉回 loader，
  // 否则重启后残留的 kernel 阶段会把 U-Boot 的启动输出全部标成内核
  if (LOADER_PATTERN.test(text)) {
    stage = 'bootloader'
    return 'bootloader'
  }
  if (stage === 'android') {
    return 'android'
  }
  // logcat 的 threadtime 格式足以确定已进入 Android 阶段
  if (ANDROID_LOG_PATTERN.test(text)) {
    stage = 'android'
    return 'android'
  }
  // 出现控制台 shell 提示符说明已经开机，之后的手动命令输出都属于 Android 阶段
  if (ANDROID_SHELL_PATTERN.test(text)) {
    stage = 'android'
    return 'android'
  }
  if (KERNEL_START_PATTERN.test(text)) {
    stage = 'kernel'
    return 'kernel'
  }
  // 出现 init/zygote 等用户态进程日志，说明内核已经起来了，进入 Android 阶段
  if (ANDROID_DAEMON_PATTERN.test(text)) {
    stage = 'android'
    return 'android'
  }
  return stage
}

function trimBuffer() {
  const count = bufferedLines()
  if (count > maxLines) {
    const remove = count - maxLines
    head += remove
    dropped += remove
  }
  // 定期整理数组，避免 head 无限增长
  if (head > 50000) {
    lines = lines.slice(head)
    head = 0
  }
}

function pushLine(text: string) {
  const line: ISerialLine = {
    seq: ++seq,
    time: Date.now(),
    source: classify(text),
    text,
  }
  lines.push(line)
  if (!paused) {
    pendingEmit.push(line)
  }
  trimBuffer()
}

function feed(text: string) {
  pendingText += text
  const parts = pendingText.split(/\r\n|\n|\r/)
  pendingText = parts.pop() || ''
  for (const part of parts) {
    if (part.trim()) {
      pushLine(part)
    }
  }
  // 某些 bootloader 会输出超长单行（无换行），截断避免内存失控
  if (pendingText.length > MAX_LINE_LENGTH) {
    pushLine(pendingText)
    pendingText = ''
  }
}

function emitLines() {
  if (emitTimer) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  if (!pendingEmit.length) {
    return
  }
  const payload: ISerialData = {
    sessionId,
    lines: pendingEmit,
    dropped,
    bytes,
    logFileSize: spoolBytes,
  }
  pendingEmit = []
  window.sendTo('main', 'serialData', payload)
}

function scheduleEmit() {
  if (paused || emitTimer) {
    return
  }
  emitTimer = setTimeout(() => {
    emitTimer = null
    emitLines()
  }, EMIT_INTERVAL)
}

function newLogFile() {
  const dir = getUserDataPath('serial')
  fs.ensureDirSync(dir)
  let file = path.join(
    dir,
    `serial-${dateFormat('yyyymmdd-HHMMss')}${logFiles.length ? `-${logFiles.length + 1}` : ''}.log`
  )
  let index = 1
  while (fs.existsSync(file)) {
    file = path.join(
      dir,
      `serial-${dateFormat('yyyymmdd-HHMMss')}-${index++}.log`
    )
  }
  spool = fs.createWriteStream(file, { flags: 'a' })
  spool.on('error', (err) => {
    logger.error(`write serial log failed: ${err.message}`)
  })
  spoolBytes = 0
  logFile = file
  logFiles.push(file)
  return file
}

function rotateLogFile() {
  if (spool) {
    spool.end()
    spool = null
  }
  newLogFile()
}

function writeSpool(chunk: Buffer) {
  if (!spool) {
    return
  }
  spool.write(chunk)
  spoolBytes += chunk.length
  if (spoolBytes >= MAX_LOG_FILE_SIZE) {
    rotateLogFile()
  }
}

function closeSpool() {
  if (spool) {
    spool.end()
    spool = null
  }
}

export function getStatus(): ISerialStatus {
  return {
    open: !!port?.isOpen,
    path: currentPath,
    baudRate: currentBaudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    paused,
    sessionId,
    startedAt,
    lines: bufferedLines(),
    seq,
    dropped,
    bytes,
    logFile,
    logFiles: logFiles.slice(),
    logFileSize: spoolBytes,
    maxLines,
    error: lastError,
  }
}

function sendStatus() {
  window.sendTo('main', 'serialStatus', getStatus())
}

export async function listPorts(): Promise<ISerialPortInfo[]> {
  try {
    const list = await SerialPort.list()
    return list.map((item) => ({
      path: item.path,
      manufacturer: item.manufacturer,
      serialNumber: item.serialNumber,
      pnpId: item.pnpId,
      vendorId: item.vendorId,
      productId: item.productId,
      friendlyName: item.friendlyName,
    }))
  } catch (err) {
    logger.error(`list serial ports failed: ${(err as Error).message}`)
    return []
  }
}

function resetSession(portPath: string, baudRate: number) {
  sessionId = uniqId('serial')
  startedAt = Date.now()
  currentPath = portPath
  currentBaudRate = baudRate
  paused = false
  lastError = ''
  lines = []
  head = 0
  seq = 0
  dropped = 0
  bytes = 0
  decoder = new StringDecoder('utf8')
  pendingText = ''
  stage = 'other'
  pendingEmit = []
  spoolBytes = 0
  logFiles = []
  logFile = ''
  maxLines =
    toNum(getSettingsStore().get('serialMaxLines')) || DEFAULT_MAX_LINES
}

function openAsync(serialPort: SerialPort) {
  return new Promise<void>((resolve, reject) => {
    serialPort.open((err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function closeAsync(serialPort: SerialPort) {
  return new Promise<void>((resolve) => {
    if (!serialPort.isOpen) {
      resolve()
      return
    }
    serialPort.close(() => resolve())
  })
}

export async function closeSerial(): Promise<ISerialStatus> {
  if (port) {
    const target = port
    port = null
    target.removeAllListeners('data')
    target.removeAllListeners('error')
    target.removeAllListeners('close')
    await closeAsync(target)
  }
  emitLines()
  closeSpool()
  sendStatus()
  return getStatus()
}

export async function openSerial(
  portPath: string,
  baudRate = 115200
): Promise<ISerialStatus> {
  if (!portPath) {
    throw new Error('serial port is required')
  }
  const rate = toNum(baudRate)
  if (!rate || rate <= 0) {
    throw new Error('invalid baud rate')
  }

  await closeSerial()

  const serialPort = new SerialPort({
    path: portPath,
    baudRate: rate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    autoOpen: false,
  })

  // 打开失败时保留上一段会话的缓冲与日志，避免误选端口导致数据被清空
  try {
    await openAsync(serialPort)
  } catch (err) {
    lastError = (err as Error).message
    port = null
    sendStatus()
    throw err
  }

  resetSession(portPath, rate)
  port = serialPort
  newLogFile()

  attachPort(serialPort)

  logger.info(`serial opened: ${portPath} @ ${rate}`)
  sendStatus()
  return getStatus()
}

function onSerialData(chunk: Buffer) {
  bytes += chunk.length
  if (detecting) {
    // 探测期间只收集样本，避免把各波特率解出的乱码写进日志
    if (detectSize < 32768) {
      detectChunks.push(chunk)
      detectSize += chunk.length
    }
    return
  }
  writeSpool(chunk)
  feed(decoder.write(chunk))
  scheduleEmit()
}

function attachPort(serialPort: SerialPort) {
  serialPort.on('data', onSerialData)

  serialPort.on('error', (err) => {
    lastError = err.message
    logger.error(`serial error: ${err.message}`)
    sendStatus()
  })

  serialPort.on('close', () => {
    closeSpool()
    sendStatus()
  })
}

function resetDecoder() {
  decoder = new StringDecoder('utf8')
  pendingText = ''
}

function updateBaud(rate: number) {
  return new Promise<void>((resolve, reject) => {
    const target = port
    if (!target || !target.isOpen) {
      reject(new Error('serial port is not open'))
      return
    }
    target.update({ baudRate: rate }, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

// 在线切换波特率：不关闭端口、不清空已有日志，便于对着主板试出正确速率
export async function changeSerialBaudRate(
  baudRate: number
): Promise<ISerialStatus> {
  if (!port || !port.isOpen) {
    throw new Error('serial port is not open')
  }
  const rate = toNum(baudRate)
  if (!rate || rate <= 0) {
    throw new Error('invalid baud rate')
  }
  if (detecting) {
    throw new Error('baud rate detection is running')
  }
  if (rate === currentBaudRate) {
    return getStatus()
  }
  await updateBaud(rate)
  currentBaudRate = rate
  resetDecoder()
  lastError = ''
  sendStatus()
  return getStatus()
}

function scoreSerialBuffer(buf: Buffer) {
  if (!buf.length) {
    return 0
  }
  const text = new StringDecoder('utf8').write(buf)
  let good = 0
  let bad = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e)) {
      good++
    } else {
      bad++
    }
  }
  const total = good + bad
  if (!total) {
    return 0
  }
  // 可打印字符越多且占比越高分数越高；乱码的高位字节会被判为 bad
  let score = good * Math.pow(good / total, 2)
  if (
    /U-Boot|Linux version|Booting Linux|Starting kernel|Kernel command line|console \[|=>|login:/i.test(
      text
    )
  ) {
    score += 2000
  }
  return score
}

// 依次用常见波特率采样，挑可读字符最多的一个，用于排查乱码
export async function detectSerialBaudRate(): Promise<{
  rate: number
  detected: boolean
}> {
  if (!port || !port.isOpen) {
    throw new Error('serial port is not open')
  }
  if (detecting) {
    throw new Error('baud rate detection is running')
  }

  const original = currentBaudRate
  let bestRate = 0
  let bestScore = 0

  detecting = true
  try {
    // 先验证当前速率，若日志本身正常就不用挨个试
    const rates = [
      currentBaudRate,
      ...DETECT_RATES.filter((rate) => rate !== currentBaudRate),
    ]
    for (const rate of rates) {
      try {
        await updateBaud(rate)
      } catch (err) {
        logger.error(`switch baud ${rate} failed: ${(err as Error).message}`)
        continue
      }
      detectChunks = []
      detectSize = 0
      await new Promise((resolve) => setTimeout(resolve, 400))
      const sample = Buffer.concat(detectChunks)
      const score = scoreSerialBuffer(sample)
      logger.info(
        `baud detect ${rate}: ${sample.length} bytes, score ${score.toFixed(1)}`
      )
      if (score > bestScore) {
        bestScore = score
        bestRate = rate
      }
      if (rate === currentBaudRate && bestScore >= 500) {
        break
      }
    }

    // 数据太少不足以判断，恢复原速率
    const rate = bestScore >= 8 ? bestRate : original
    await updateBaud(rate)
    currentBaudRate = rate
    if (rate !== original) {
      resetDecoder()
    }
    return { rate, detected: bestScore >= 8 }
  } finally {
    detecting = false
    detectChunks = []
    detectSize = 0
    resetDecoder()
    sendStatus()
  }
}

export function clearSerial(): ISerialStatus {
  lines = []
  head = 0
  dropped = 0
  pendingEmit = []
  seq = 0
  bytes = 0
  pendingText = ''
  decoder = new StringDecoder('utf8')
  // 清空只清显示缓冲，设备仍处在原来的阶段（已开机就是 Android），
  // 因此保留 stage；板子重启后由引导特征自动把阶段拉回 bootloader
  startedAt = Date.now()
  closeSpool()
  logFiles = []
  logFile = ''
  // 只在串口仍打开时新建日志文件，未连接时清除不产生空文件
  if (port?.isOpen) {
    newLogFile()
  }
  sendStatus()
  return getStatus()
}

export function setSerialPaused(value: boolean): ISerialStatus {
  paused = !!value
  if (paused) {
    if (emitTimer) {
      clearTimeout(emitTimer)
      emitTimer = null
    }
    pendingEmit = []
  }
  sendStatus()
  return getStatus()
}

export function queryLines(query: ISerialQuery = {}): ISerialQueryResult {
  const keyword = (query.keyword || '').trim()
  let pattern: RegExp | null = null
  if (keyword) {
    try {
      pattern = new RegExp(
        query.regex ? keyword : escapeRegExp(keyword),
        'i'
      )
    } catch (err) {
      throw new Error(`invalid regex: ${(err as Error).message}`)
    }
  }

  const source = query.source && query.source !== 'all' ? query.source : ''
  const fromSeq = query.fromSeq || 0
  const toSeq = query.toSeq || Number.MAX_SAFE_INTEGER
  // 渲染进程恢复现场时需要一次拿较多行，上限放宽；MCP 层会再限制返回条数
  const limit =
    query.lines === 0 ? 0 : Math.min(Math.max(query.lines || 200, 1), 60000)

  const latest = !!query.latest
  const result: ISerialLine[] = []
  let matched = 0

  for (let i = head; i < lines.length; i++) {
    const line = lines[i]
    if (line.seq < fromSeq || line.seq > toSeq) {
      continue
    }
    if (source && line.source !== source) {
      continue
    }
    if (pattern && !pattern.test(line.text)) {
      continue
    }
    matched++
    if (limit === 0) {
      result.push(line)
    } else if (result.length < limit) {
      result.push(line)
    } else if (latest) {
      // 只保留最近的 limit 行，避免返回早已滚出去的开头
      result.shift()
      result.push(line)
    }
  }

  if (limit > 0 && result.length > limit) {
    result.length = limit
  }

  return {
    total: bufferedLines(),
    matched,
    returned: result.length,
    truncated: matched > result.length,
    lines: result,
    status: getStatus(),
  }
}

async function appendFileTo(source: string, out: fs.WriteStream) {
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(source)
    input.on('error', reject)
    out.on('error', reject)
    input.on('end', resolve)
    input.pipe(out, { end: false })
  })
}

export async function saveSerial(
  mode: 'view' | 'session' = 'view',
  query: ISerialQuery = {}
): Promise<string> {
  const options = {
    title: 'Save Serial Log',
    defaultPath: `serial-${dateFormat('yyyymmdd-HHmmss')}.log`,
    filters: [
      { name: 'Log', extensions: ['log', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }
  const mainWin = window.getWin('main')
  const result = mainWin
    ? await dialog.showSaveDialog(mainWin, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return ''
  }

  const filePath = result.filePath
  if (mode === 'session') {
    if (!logFiles.length) {
      throw new Error('no serial log file')
    }
    await fs.ensureFile(filePath)
    if (logFiles.length === 1) {
      await fs.copyFile(logFiles[0], filePath)
      return filePath
    }
    const out = fs.createWriteStream(filePath)
    for (const file of logFiles) {
      await appendFileTo(file, out)
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject)
      out.end(resolve)
    })
    return filePath
  }

  const { lines: matched } = queryLines({
    ...query,
    lines: 0,
  })
  await fs.writeFile(
    filePath,
    matched.map((line) => line.text).join('\n'),
    'utf8'
  )
  return filePath
}

export async function writeSerial(
  data: string,
  newline: boolean | 'crlf' | 'lf' | 'none' = true
) {
  if (!port || !port.isOpen) {
    throw new Error('serial port is not open')
  }
  if (typeof data !== 'string' || !data.length) {
    throw new Error('data is required')
  }
  if (data.length > 4096) {
    throw new Error('data is too long')
  }
  let suffix = '\r\n'
  if (newline === false || newline === 'none') {
    suffix = ''
  } else if (newline === 'lf') {
    suffix = '\n'
  }
  await new Promise<void>((resolve, reject) => {
    port!.write(data + suffix, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
  await new Promise<void>((resolve) => {
    port!.drain(() => resolve())
  })
}

export async function waitSerial(
  pattern: string,
  options: { regex?: boolean; timeout?: number } = {}
) {
  const keyword = (pattern || '').trim()
  if (!keyword) {
    throw new Error('pattern is required')
  }
  let re: RegExp
  try {
    re = new RegExp(options.regex ? keyword : escapeRegExp(keyword), 'i')
  } catch (err) {
    throw new Error(`invalid regex: ${(err as Error).message}`)
  }

  const timeout = Math.min(Math.max(options.timeout || 15000, 1000), 300000)
  const begin = Date.now()
  let cursor = seq

  while (Date.now() - begin < timeout) {
    for (let i = head; i < lines.length; i++) {
      const line = lines[i]
      if (line.seq <= cursor) {
        continue
      }
      cursor = line.seq
      if (re.test(line.text)) {
        return {
          matched: true,
          waited: Date.now() - begin,
          line,
        }
      }
    }
    if (!port || !port.isOpen) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  return {
    matched: false,
    waited: Date.now() - begin,
    line: null,
  }
}

export function init() {
  handleEvent('serialListPorts', listPorts)
  handleEvent('serialOpen', openSerial)
  handleEvent('serialClose', closeSerial)
  handleEvent('serialStatus', () => getStatus())
  handleEvent('serialSetPaused', setSerialPaused)
  handleEvent('serialClear', clearSerial)
  handleEvent('serialQuery', queryLines)
  handleEvent('serialSave', saveSerial)
  handleEvent('serialWrite', writeSerial)
  handleEvent('serialWait', waitSerial)
  handleEvent('serialSetBaud', changeSerialBaudRate)
  handleEvent('serialDetectBaud', detectSerialBaudRate)

  app.on('will-quit', () => {
    if (port) {
      port.close(() => {})
      port = null
    }
    closeSpool()
  })
}
