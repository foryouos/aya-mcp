import * as adb from '../../adb'
import * as base from '../../adb/base'
import { dumpFast, invalidateDump, withDeviceQueue } from './dump'
import {
  diffFrame,
  IUiNode,
  markSnapshotStale,
  parseSnapshot,
  takeLastFrame,
} from './snapshot'
import { resolveTarget } from './target'
import { labelNode, pickActionable } from './ui'
import { assertShellOk } from './shellCheck'
import { McpError } from './result'

export const KEY_CODES: { [name: string]: number } = {
  back: 4,
  home: 3,
  enter: 66,
  menu: 82,
  recent: 187,
  app_switch: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  delete: 67,
  tab: 61,
  escape: 111,
  search: 84,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function resolveSettle(args: any, fallback: number) {
  return typeof args.settle === 'number' && args.settle >= 0
    ? args.settle
    : fallback
}

export async function afterInput(
  deviceId: string,
  settle: number = 300,
  reason = '输入操作后界面已变化'
) {
  invalidateDump(deviceId)
  // 只标记过期不删除：节点签名还要留给下一次 captureUi 做对比，
  // 但按 nodeIndex 点击会要求重新 dump，避免用旧坐标点错位置
  markSnapshotStale(deviceId, reason)

  if (settle > 0) {
    await sleep(settle)
  }

  return settle
}

// withUi: "auto" 时按动作类型决定是否抓帧：
// 点击容易触发瞬时控件（视频控制栏、Toast 弹出），默认抓；
// 滑动/按键通常连续执行，默认不抓，省掉每次 0.3-1s 的 dump
export function resolveWithUi(value: unknown, fallback: boolean) {
  if (value === true) {
    return true
  }
  if (value === false) {
    return false
  }

  return fallback
}

export function resolveKeyCode(input: unknown) {
  if (typeof input === 'number') {
    return Math.round(input)
  }

  return KEY_CODES[String(input || '').toLowerCase()] || 0
}

export interface ICapture {
  snapshotId: string
  fingerprint: string
  source: string
  total: number
  capturedMs: number
  dumpMs: number
  parseMs: number
  changed: boolean
  appeared: any[]
  disappeared: any[]
  nodes: any[]
  actionableTotal: number
  truncated: boolean
  hint: string
}

function labelGone(node: IUiNode) {
  const label = labelNode(node)
  delete label.i

  return label
}

/**
 * 动作执行后立刻抓一帧界面：返回可交互节点 + 与上一帧的差异。
 * 目的是让「点击 → 观察」在一次工具调用里完成，避免易失控件（视频控制栏等）
 * 在模型往返期间自动隐藏。
 */
export async function captureUi(
  deviceId: string,
  options: { maxNodes?: number; diff?: boolean } = {}
): Promise<ICapture> {
  const started = Date.now()
  // 这里是「操作后的界面」，必须是最新一帧，不能命中 1 秒 dump 缓存
  invalidateDump(deviceId)
  const dump = await dumpFast(deviceId)
  const dumpedAt = Date.now()
  const snapshot = parseSnapshot(deviceId, dump.xml, true)
  const parsedAt = Date.now()

  // 无论是否比对都要取走帧，避免下次拿到过期基准
  const frame = takeLastFrame(deviceId)
  const diff =
    options.diff === false
      ? { comparable: false, changed: false, appeared: [], disappeared: [] }
      : diffFrame(frame, snapshot.flat)

  const maxNodes = Math.min(
    Math.max(Math.floor(Number(options.maxNodes) || 60), 1),
    200
  )
  const picked = pickActionable(snapshot.flat, maxNodes)

  let hint = ''
  if (picked.total === 0) {
    hint =
      '没有读到可交互节点：视频/游戏等 SurfaceView 画面 uiautomator 读不到，请改用 aya_screencap 从截图判断'
  } else if (diff.comparable && !diff.changed) {
    hint = '界面与上一帧完全一致，操作可能未生效或界面还在加载'
  }

  return {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    source: dump.source,
    total: snapshot.flat.length,
    capturedMs: Date.now() - started,
    dumpMs: dumpedAt - started,
    parseMs: parsedAt - dumpedAt,
    changed: diff.changed,
    appeared: diff.appeared.slice(0, 20).map(labelNode),
    disappeared: diff.disappeared.slice(0, 20).map(labelGone),
    nodes: picked.nodes,
    actionableTotal: picked.total,
    truncated: picked.truncated,
    hint,
  }
}

export async function performTap(args: any, settle: number) {
  const target = await resolveTarget(args)
  const output = await withDeviceQueue(target.deviceId, () =>
    adb.inputTap(target.deviceId, target.point[0], target.point[1])
  )
  assertShellOk(output, 'aya_tap')
  const settledMs = await afterInput(target.deviceId, settle)

  return { target, settledMs }
}

export async function performSwipe(
  deviceId: string,
  coords: { x1: number; y1: number; x2: number; y2: number },
  duration: number,
  settle: number
) {
  const output = await withDeviceQueue(deviceId, () =>
    adb.inputSwipe(
      deviceId,
      coords.x1,
      coords.y1,
      coords.x2,
      coords.y2,
      duration
    )
  )
  assertShellOk(output, 'aya_swipe')

  return afterInput(deviceId, settle)
}

export async function performKey(
  deviceId: string,
  input: unknown,
  settle: number
) {
  const code = resolveKeyCode(input)
  if (!code) {
    throw new McpError(
      'INVALID_ARGS',
      `未知按键 ${String(input)}，可用：${Object.keys(KEY_CODES).join(', ')}`
    )
  }

  await withDeviceQueue(deviceId, () => adb.inputKey(deviceId, code))
  const settledMs = await afterInput(deviceId, settle)

  return { code, settledMs }
}

// 会改写输入的输入法：Gboard/搜狗/百度/讯飞等在 input text 时会做联想、大小写纠正、
// 自动补空格，导致最终文本和请求不一致
const REWRITE_IME = /gboard|google|sogou|baidu|iflytek|swiftkey|kika|输入法/i
const SAFE_IME = /latin|aosp|adbkeyboard/i

async function getDefaultIme(deviceId: string) {
  const out = await base
    .shell(deviceId, 'settings get secure default_input_method')
    .catch(() => '')

  return String(out || '').trim()
}

async function listImeIds(deviceId: string) {
  for (const cmd of ['ime list -s', 'ime list -a -s']) {
    const out = await base.shell(deviceId, cmd).catch(() => '')
    const ids = String(out || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[\w.]+\/[\w.$]+$/.test(line))
    if (ids.length) {
      return ids
    }
  }

  return []
}

// 输入前临时切到不带联想的输入法，输入后恢复原输入法
async function resolveSafeIme(deviceId: string) {
  const current = await getDefaultIme(deviceId)
  if (!current || current === 'null' || !REWRITE_IME.test(current)) {
    return { current, used: current, switched: false, risk: false }
  }

  const ids = await listImeIds(deviceId)
  const candidates = ids.filter(
    (id) => id !== current && !REWRITE_IME.test(id)
  )
  const safe =
    candidates.find((id) => SAFE_IME.test(id)) || candidates[0] || ''

  if (!safe) {
    return { current, used: current, switched: false, risk: true }
  }

  return { current, used: safe, switched: true, risk: false }
}

async function waitIme(deviceId: string, imeId: string) {
  for (let i = 0; i < 10; i++) {
    const current = await getDefaultIme(deviceId)
    if (current === imeId) {
      return true
    }
    await sleep(60)
  }

  return false
}

// 清空当前输入框：优先 Ctrl+A 全选后删除，失败则退化成连发删除键
async function clearField(deviceId: string) {
  const out = await base
    .shell(deviceId, 'input keycombination 113 29 && input keyevent 67')
    .catch((err) => String(err && err.message ? err.message : err))
  if (!/error|unknown|usage|exception|invalid/i.test(String(out))) {
    return 'keycombination'
  }

  const keys = new Array(40).fill('67').join(' ')
  await base.shell(deviceId, `input keyevent ${keys}`)

  return 'delete'
}

export interface ITextOptions {
  clear?: boolean
  ime?: 'auto' | 'keep'
}

export async function performText(
  deviceId: string,
  value: string,
  settle: number,
  options: ITextOptions = {}
) {
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new McpError(
      'INVALID_ARGS',
      '输入仅支持可打印 ASCII 字符；中文等非 ASCII 文本请用 aya_shell 配合设备输入法'
    )
  }

  const useSafeIme = options.ime !== 'keep'
  const ime = useSafeIme
    ? await resolveSafeIme(deviceId)
    : { current: '', used: '', switched: false, risk: false }

  let cleared = ''
  let restored = false

  try {
    if (ime.switched) {
      await base.shell(deviceId, `ime set ${ime.used}`).catch(() => '')
      await waitIme(deviceId, ime.used)
    }

    if (options.clear !== false) {
      cleared = await clearField(deviceId)
    }

    const escaped = value.replace(/'/g, `'\\''`).replace(/ /g, '%s')
    const output = await withDeviceQueue(deviceId, () =>
      base.shell(deviceId, `input text '${escaped}'`)
    )
    assertShellOk(output, 'aya_text')
  } finally {
    if (ime.switched && ime.current) {
      await base.shell(deviceId, `ime set ${ime.current}`).catch(() => '')
      restored = true
    }
  }

  const settledMs = await afterInput(deviceId, settle)

  return {
    settledMs,
    cleared: cleared || 'none',
    ime: {
      mode: useSafeIme ? 'auto' : 'keep',
      current: ime.current || null,
      used: ime.used || null,
      switched: ime.switched,
      restored,
      // 没有可用的替代输入法时，文本仍可能被联想改写
      risk: ime.risk,
    },
  }
}

// 输入后回读界面上焦点输入框的实际内容，用于确认文本没有被输入法改写
export async function verifyFocusedText(deviceId: string, expected: string) {
  invalidateDump(deviceId)
  const dump = await dumpFast(deviceId)
  const snapshot = parseSnapshot(deviceId, dump.xml, true)
  const focused = snapshot.flat.find((node) => node.focused)

  return {
    snapshotId: snapshot.id,
    matched: !!focused && focused.text === expected,
    actualText: focused ? focused.text : null,
    focusedNode: focused
      ? { i: focused.i, cls: focused.cls, id: focused.id, text: focused.text }
      : null,
  }
}
