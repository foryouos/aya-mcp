// 轻量运行时指标：只保留最近若干次样本，避免长时间运行后内存膨胀。
// 用途是让 AI/开发者判断「哪个工具慢、dump 占了多少时间」，不做持久化。

const SAMPLE_LIMIT = 50

export interface IToolStat {
  calls: number
  errors: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lastMs: number
  lastAt: number
  errorCodes: { [code: string]: number }
}

interface IToolRecord {
  calls: number
  errors: number
  totalMs: number
  maxMs: number
  lastMs: number
  lastAt: number
  samples: number[]
  errorCodes: { [code: string]: number }
}

const startedAt = Date.now()
const tools: { [name: string]: IToolRecord } = {}

let dumpCount = 0
let dumpFailed = 0
let dumpCacheHits = 0
let dumpTotalMs = 0
let lastDumpMs = 0

function percentile(samples: number[], p: number) {
  if (!samples.length) {
    return 0
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  )

  return sorted[index]
}

export function recordTool(
  name: string,
  ms: number,
  errorCode?: string | null
) {
  let record = tools[name]
  if (!record) {
    record = {
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      lastAt: 0,
      samples: [],
      errorCodes: {},
    }
    tools[name] = record
  }

  record.calls++
  record.totalMs += ms
  record.lastMs = ms
  record.lastAt = Date.now()
  record.maxMs = Math.max(record.maxMs, ms)
  record.samples.push(ms)
  if (record.samples.length > SAMPLE_LIMIT) {
    record.samples.shift()
  }

  if (errorCode) {
    record.errors++
    record.errorCodes[errorCode] = (record.errorCodes[errorCode] || 0) + 1
  }
}

// ok=false 表示这次 dump 真正发起了但失败，用于区分「解析失败」与「未调用」
export function recordDump(ms: number, ok = true) {
  if (!ok) {
    dumpFailed++
    return
  }

  dumpCount++
  dumpTotalMs += ms
  lastDumpMs = ms
}

export function recordDumpCacheHit() {
  dumpCacheHits++
}

export interface IStatsSnapshot {
  since: number
  uptimeMs: number
  dump: {
    count: number
    failed: number
    cacheHits: number
    totalMs: number
    avgMs: number
    lastMs: number
    reuseRate: number
  }
  totals: {
    calls: number
    errors: number
    avgMs: number
  }
  tools: (IToolStat & { name: string })[]
}

export function getStats(): IStatsSnapshot {
  const names = Object.keys(tools)
  let calls = 0
  let errors = 0
  let totalMs = 0

  const list = names.map((name) => {
    const record = tools[name]
    calls += record.calls
    errors += record.errors
    totalMs += record.totalMs

    return {
      name,
      calls: record.calls,
      errors: record.errors,
      totalMs: record.totalMs,
      avgMs: Math.round(record.totalMs / record.calls),
      p50Ms: percentile(record.samples, 0.5),
      p95Ms: percentile(record.samples, 0.95),
      maxMs: record.maxMs,
      lastMs: record.lastMs,
      lastAt: record.lastAt,
      errorCodes: record.errorCodes,
    }
  })

  list.sort((a, b) => b.totalMs - a.totalMs)

  return {
    since: startedAt,
    uptimeMs: Date.now() - startedAt,
    dump: {
      count: dumpCount,
      failed: dumpFailed,
      cacheHits: dumpCacheHits,
      totalMs: dumpTotalMs,
      avgMs: dumpCount ? Math.round(dumpTotalMs / dumpCount) : 0,
      lastMs: lastDumpMs,
      reuseRate: dumpCount + dumpCacheHits
        ? Math.round((dumpCacheHits / (dumpCount + dumpCacheHits)) * 100) / 100
        : 0,
    },
    totals: {
      calls,
      errors,
      avgMs: calls ? Math.round(totalMs / calls) : 0,
    },
    tools: list,
  }
}

export function resetStats() {
  Object.keys(tools).forEach((name) => delete tools[name])
  dumpCount = 0
  dumpFailed = 0
  dumpCacheHits = 0
  dumpTotalMs = 0
  lastDumpMs = 0
}
