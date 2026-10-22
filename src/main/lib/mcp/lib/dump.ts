import * as base from '../../adb/base'
import { dumpWindowHierarchy } from '../../adb'
import { McpError } from './result'
import log from 'share/common/log'

const logger = log('mcp')

const UIDUMP_PATH = '/data/local/tmp/aya_mcp_uidump.xml'
const CACHE_TTL = 1000

export interface IDumpResult {
  xml: string
  source: 'fast' | 'fallback' | 'cache'
  ms: number
}

const cache: {
  [deviceId: string]: { xml: string; at: number; source: 'fast' | 'fallback' }
} = {}

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

async function doDump(deviceId: string): Promise<IDumpResult> {
  const started = Date.now()
  const cached = cache[deviceId]
  if (cached && started - cached.at < CACHE_TTL) {
    return { xml: cached.xml, source: 'cache', ms: 0 }
  }

  let xml = ''
  let source: 'fast' | 'fallback' = 'fast'

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

  if (!xml) {
    source = 'fallback'
    xml = extractXml(
      await dumpWindowHierarchy(deviceId).catch(() => '')
    )
  }

  if (!xml) {
    throw new McpError(
      'DUMP_FAILED',
      'uiautomator dump 失败，可能处于动画、输入法或安全窗口，请稍后重试'
    )
  }

  cache[deviceId] = { xml, at: Date.now(), source }

  return { xml, source, ms: Date.now() - started }
}

export function dumpFast(deviceId: string): Promise<IDumpResult> {
  return withDeviceQueue(deviceId, () => doDump(deviceId))
}
