import * as adb from '../../adb'
import * as base from '../../adb/base'
import { dumpFast, invalidateDump, withDeviceQueue } from './dump'
import {
  diffFrame,
  invalidateSnapshot,
  IUiNode,
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

export async function afterInput(deviceId: string, settle: number = 300) {
  invalidateDump(deviceId)
  // 作废旧快照，同时把旧帧签名留给下一次 captureUi 做对比
  invalidateSnapshot(deviceId)

  if (settle > 0) {
    await sleep(settle)
  }

  return settle
}

export function resolveKeyCode(input: unknown) {
  if (typeof input === 'number') {
    return Math.round(input)
  }

  return KEY_CODES[String(input || '').toLowerCase()] || 0
}

export interface ICapture {
  snapshotId: string
  source: string
  total: number
  capturedMs: number
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
  const snapshot = parseSnapshot(deviceId, dump.xml, true)

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
    source: dump.source,
    total: snapshot.flat.length,
    capturedMs: Date.now() - started,
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

export async function performText(
  deviceId: string,
  value: string,
  settle: number
) {
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new McpError(
      'INVALID_ARGS',
      '输入仅支持可打印 ASCII 字符；中文等非 ASCII 文本请用 aya_shell 配合设备输入法'
    )
  }

  const escaped = value.replace(/'/g, `'\\''`).replace(/ /g, '%s')
  const output = await withDeviceQueue(deviceId, () =>
    base.shell(deviceId, `input text '${escaped}'`)
  )
  assertShellOk(output, 'aya_text')
  const settledMs = await afterInput(deviceId, settle)

  return settledMs
}
