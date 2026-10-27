#!/usr/bin/env node
/**
 * AYA MCP 与 uiautomator2 的同板对比基准（AYA 侧）。
 *
 * 直接走 MCP 的 HTTP 端点（POST /mcp），不经过 AI 客户端，测量的是
 * 「工具调用 → 设备执行 → 结果返回」这一段纯链路耗时。
 *
 * 注意：aya 的常驻 UiAutomation 与 uiautomator2 争抢同一个无障碍连接，
 * 测 aya 之前要先停掉 u2 的 atx-agent（python -c "import uiautomator2 as u2; u2.connect(serial).stop_atx_agent()"）。
 *
 * 用法：
 *    node script/bench/bench_aya.mjs --out tmp-bench-aya.json
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

const URL = arg('url', 'http://127.0.0.1:7788/mcp')
const OUT = arg('out', 'tmp-bench-aya.json')
const N_DUMP = Number(arg('dump', 20))
const N_CLICK = Number(arg('click', 20))
const N_SWIPE = Number(arg('swipe', 20))
const N_TEXT = Number(arg('text', 10))
const N_SHOT = Number(arg('shot', 10))
const SAFE_CLICK = { x: 5, y: 1050 }
const SAFE_SWIPE = { x1: 5, y1: 1000, x2: 5, y2: 900, duration: 300 }
const SEARCH_BOX = { x: 317, y: 56 }

function readToken() {
  if (process.env.AYA_MCP_TOKEN) {
    return process.env.AYA_MCP_TOKEN
  }

  const cfg = path.join(os.homedir(), '.codebuddy', 'mcp.json')
  try {
    const json = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    const servers = json.mcpServers || json.servers || {}
    const aya = servers.aya || {}
    if (aya.env && aya.env.AYA_MCP_TOKEN) {
      return aya.env.AYA_MCP_TOKEN
    }
    const raw = JSON.stringify(aya)
    const m = /--token=([0-9a-f]+)/.exec(raw)

    return m ? m[1] : ''
  } catch {
    return ''
  }
}

const TOKEN = readToken()
if (!TOKEN) {
  console.error('no token: set AYA_MCP_TOKEN or ~/.codebuddy/mcp.json')
  process.exit(1)
}

let seq = 0
async function call(name, args) {
  seq += 1
  const started = performance.now()
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: seq,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    }),
  })
  const payload = await res.json()
  const ms = performance.now() - started
  if (payload.error) {
    throw new Error(`${name}: ${JSON.stringify(payload.error)}`)
  }

  const result = payload.result || {}
  const text = (result.content || []).find((c) => c.type === 'text')
  let data = null
  if (text) {
    try {
      data = JSON.parse(text.text)
    } catch {
      data = null
    }
  }
  const image = (result.content || []).find((c) => c.type === 'image')

  return { ms, data, imageBytes: image ? Math.floor((image.data.length * 3) / 4) : 0 }
}

function stats(samples, bytes) {
  const sorted = [...samples].sort((a, b) => a - b)
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    n: samples.length,
    avgMs: Math.round(avg * 10) / 10,
    p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    p95Ms: Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] * 10) / 10,
    minMs: Math.round(sorted[0] * 10) / 10,
    maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
    bytes: bytes || 0,
  }
}

async function bench(name, fn, times, gap = 0) {
  const samples = []
  let bytes = 0
  for (let i = 0; i < times; i++) {
    if (gap && i > 0) {
      await new Promise((r) => setTimeout(r, gap))
    }
    const out = await fn()
    samples.push(out.ms)
    if (out.bytes) {
      bytes = out.bytes
    }
  }

  return stats(samples, bytes)
}

async function main() {
  // 探活，确认 MCP 服务与令牌可用
  const alive = await call('aya_list_devices', {})
  if (!alive.data) {
    console.error('aya mcp not reachable')
    process.exit(1)
  }

  const result = { impl: 'aya-mcp', url: URL, device: alive.data.devices[0].name }

  // 预热：首次调用要拉起设备端常驻服务（push dex + app_process），不算入样本
  await call('aya_ui_dump', {})

  // 1. UI 层级（间隔 1.1s，避开 dump 的 1s 缓存，保证每次都是真实 dump）
  result.dump = await bench('dump', async () => {
    const out = await call('aya_ui_dump', {})
    return { ms: out.ms, bytes: JSON.stringify(out.data || {}).length }
  }, N_DUMP, 1100)

  // 2. 点击（无副作用坐标，settle=0 去掉额外等待）
  result.click = await bench('click', async () => {
    const out = await call('aya_tap', { ...SAFE_CLICK, withUi: false, settle: 0 })

    return { ms: out.ms }
  }, N_CLICK)

  // 3. 滑动
  result.swipe = await bench('swipe', async () => {
    const out = await call('aya_swipe', { ...SAFE_SWIPE, withUi: false, settle: 0 })

    return { ms: out.ms }
  }, N_SWIPE)

  // 4. 文本输入：先点开设置搜索框拿到焦点
  await call('aya_tap', { ...SEARCH_BOX, withUi: false, settle: 300 })
  await new Promise((r) => setTimeout(r, 800))
  result.text = await bench('text', async () => {
    const out = await call('aya_text', { text: 'aya bench', clear: true, settle: 0 })

    return { ms: out.ms }
  }, N_TEXT)

  // 5. 截图
  result.screenshot = await bench('shot', async () => {
    const out = await call('aya_screencap', { maxWidth: 900, quality: 72 })

    return { ms: out.ms, bytes: out.imageBytes }
  }, N_SHOT)

  // 6. 「按控件定位并点击」：agent 最常用的一步
  // 用搜索页里的 EditText（android:id/search_src_text）做同口径对比
  await call('aya_tap', { ...SEARCH_BOX, withUi: false, settle: 300 })
  await new Promise((r) => setTimeout(r, 800))
  result.tapById = await bench('tapById', async () => {
    const out = await call('aya_tap', {
      id: 'search_src_text',
      withUi: false,
      settle: 0,
    })

    return { ms: out.ms }
  }, 10)

  // 6b. 中文文本定位（aya 侧无编码问题）
  await call('aya_key', { key: 'back', withUi: false, settle: 300 })
  result.tapByText = await bench('tapByText', async () => {
    const out = await call('aya_tap', { text: '搜索', withUi: false, settle: 0 })

    return { ms: out.ms }
  }, 10)

  // 5b. 点击按压时长：injectInputEvent(sync=false) 不等待应用消费，
  // 预期 pressMs 只影响事件时间戳，不影响耗时
  result.tapPress0 = await bench('tapPress0', async () => {
    const out = await call('aya_tap', {
      x: 5,
      y: 1050,
      withUi: false,
      settle: 0,
      pressMs: 0,
    })

    return { ms: out.ms }
  }, 20)
  result.tapPress20 = await bench('tapPress20', async () => {
    const out = await call('aya_tap', {
      x: 5,
      y: 1050,
      withUi: false,
      settle: 0,
      pressMs: 20,
    })

    return { ms: out.ms }
  }, 20)

  // 7. 原始 XML 层级（与 u2 的 compressed XML 同口径）
  await call('aya_key', { key: 'back', withUi: false, settle: 300 })
  result.dumpRaw = await bench('dumpRaw', async () => {
    const out = await call('aya_ui_dump', { raw: true })
    return { ms: out.ms, bytes: JSON.stringify(out.data || {}).length }
  }, 10, 1100)

  // 8. 设备端裁剪（deviceCrop）：把节点裁剪下推到设备端，量化第 2 项的收益。
  // 该参数是实验性的：返回的树是稀疏的，后续定位请改用整树 dump。
  try {
    await call('aya_key', { key: 'back', withUi: false, settle: 300 })
    result.dumpDeviceCrop = await bench('dumpDeviceCrop', async () => {
      const out = await call('aya_ui_dump', {
        deviceCrop: { maxNodes: 100, visibleOnly: true },
      })
      return { ms: out.ms, bytes: JSON.stringify(out.data || {}).length }
    }, 10, 1100)
  } catch (err) {
    result.dumpDeviceCrop = { error: String(err) }
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
