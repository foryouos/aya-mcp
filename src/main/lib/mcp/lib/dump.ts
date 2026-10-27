import * as base from '../../adb/base'
import { dumpWindowHierarchy } from '../../adb'
import { dumpUiXml } from '../../adb/server'
import { McpError } from './result'
import { recordDump, recordDumpCacheHit } from './stats'
import log from 'share/common/log'

const logger = log('mcp')

const UIDUMP_PATH = '/data/local/tmp/aya_mcp_uidump.xml'
const CACHE_TTL = 1000
// 无障碍通道不可用时熔断 5 分钟，避免每次 dump 都白付一次 RPC
const ACCESSIBILITY_RETRY_MS = 5 * 60 * 1000
const ACCESSIBILITY_TIMEOUT = 12000
const ACCESSIBILITY_MAX_NODES = 2000
const ACCESSIBILITY_MAX_DEPTH = 60

type DumpSource = 'accessibility' | 'fast' | 'fallback'

export interface IDumpResult {
  xml: string
  source: DumpSource | 'cache'
  ms: number
}

const cache: {
  [key: string]: { xml: string; at: number; source: DumpSource }
} = {}

const accessibilityBlocked: { [deviceId: string]: number } = {}

/**
 * dump 的缓存键要带上裁剪参数：全量与裁剪的 XML 内容不同，
 * 共用一个键会让「先裁剪后全量」拿到被截断的树。
 */
function cacheKey(deviceId: string, maxNodes: number, maxDepth: number) {
  return `${deviceId}|${maxNodes}|${maxDepth}`
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 常驻 UiAutomation 通道：省掉每次 dump 的进程启动与 connect，实测 2.5s → 百毫秒级。
 * 任何失败都返回空串并熔断，由调用方降级。
 */
async function dumpViaAccessibility(
  deviceId: string,
  maxNodes: number,
  maxDepth: number
): Promise<string> {
  if (Date.now() < (accessibilityBlocked[deviceId] || 0)) {
    return ''
  }

  const xml = await withTimeout(
    dumpUiXml(deviceId, {
      maxNodes,
      maxDepth,
    }).catch((err) => {
      logger.debug('ui.dump failed', err && err.message)

      return ''
    }),
    ACCESSIBILITY_TIMEOUT
  ).catch(() => '')

  if (xml && xml.indexOf('<hierarchy') >= 0) {
    return extractXml(xml)
  }

  logger.info('accessibility dump unavailable, fallback to uiautomator')
  accessibilityBlocked[deviceId] = Date.now() + ACCESSIBILITY_RETRY_MS

  return ''
}

const queues: { [deviceId: string]: Promise<unknown> } = {}

export function withDeviceQueue<T>(
  deviceId: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = queues[deviceId] || Promise.resolve()
  const next = prev.then(task, task)
  queues[deviceId] = next.catch(() => undefined)

  return next
}

export function invalidateDump(deviceId?: string) {
  if (deviceId) {
    delete cache[deviceId]
    return
  }

  Object.keys(cache).forEach((key) => delete cache[key])
}

export function extractXml(output: string): string {
  if (!output) {
    return ''
  }
  const start = output.indexOf('<hierarchy')
  const end = output.lastIndexOf('</hierarchy>')
  if (start < 0 || end < start) {
    return ''
  }

  return output.slice(start, end + 12)
}

async function runDump(deviceId: string, joiner: '&&' | ';') {
  const cmd = `rm -f ${UIDUMP_PATH}; uiautomator dump --compressed ${UIDUMP_PATH} ${joiner} cat ${UIDUMP_PATH}`

  return base.shell(deviceId, cmd)
}

async function doDump(
  deviceId: string,
  maxNodes: number,
  maxDepth: number
): Promise<IDumpResult> {
  const started = Date.now()
  const key = cacheKey(deviceId, maxNodes, maxDepth)
  const cached = cache[key]
  if (cached && started - cached.at < CACHE_TTL) {
    recordDumpCacheHit()

    return { xml: cached.xml, source: 'cache', ms: 0 }
  }

  let xml = await dumpViaAccessibility(deviceId, maxNodes, maxDepth)
  let source: DumpSource = 'accessibility'

  if (!xml) {
    source = 'fast'
    for (const joiner of ['&&', ';'] as const) {
      const output = await runDump(deviceId, joiner).catch((err) => {
        logger.debug('dump failed', err && err.message)
        return ''
      })
      xml = extractXml(output)
      if (xml) {
        break
      }
    }
  }

  if (!xml) {
    source = 'fallback'
    xml = extractXml(
      await dumpWindowHierarchy(deviceId).catch(() => '')
    )
  }

  if (!xml) {
    recordDump(0, false)
    throw new McpError(
      'DUMP_FAILED',
      'uiautomator dump 失败，可能处于动画、输入法或安全窗口，请稍后重试'
    )
  }

  cache[key] = { xml, at: Date.now(), source }
  const ms = Date.now() - started
  recordDump(ms)

  return { xml, source, ms }
}

export interface IDumpOptions {
  // 设备端生成节点的预算：调小可显著减少传输与解析量，但返回的树会被截断
  maxNodes?: number
  maxDepth?: number
}

export function dumpFast(
  deviceId: string,
  options: IDumpOptions = {}
): Promise<IDumpResult> {
  const maxNodes = Math.max(
    1,
    Math.min(Math.floor(Number(options.maxNodes) || ACCESSIBILITY_MAX_NODES), 20000)
  )
  const maxDepth = Math.max(
    1,
    Math.min(Math.floor(Number(options.maxDepth) || ACCESSIBILITY_MAX_DEPTH), 200)
  )

  return withDeviceQueue(deviceId, () => doDump(deviceId, maxNodes, maxDepth))
}
