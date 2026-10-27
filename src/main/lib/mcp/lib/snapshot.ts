import { createHash, randomBytes } from 'node:crypto'
import { DOMParser, Element } from '@xmldom/xmldom'
import { McpError } from './result'

export interface IUiNode {
  i: number
  text: string
  desc: string
  id: string
  cls: string
  pkg: string
  clickable: boolean
  focusable: boolean
  focused: boolean
  scrollable: boolean
  checked: boolean
  selected: boolean
  enabled: boolean
  // bounds 是裁剪到父容器/窗口后的可见区域；完全不可见时为原始值，配合 visible:false 判断
  bounds: number[]
  center: number[]
  // 与父容器求交后是否还有可见像素。false 表示被滚动容器裁掉或容器本身尺寸为 0
  visible: boolean
  // 原始 bounds，仅在裁剪后与 bounds 不一致时保留，便于诊断越界节点
  rawBounds?: number[]
  depth: number
  children: IUiNode[]
}

export interface ISnapshot {
  id: string
  deviceId: string
  xml: string
  root: IUiNode | null
  // 状态栏、导航栏、输入法各自是独立窗口，服务端会返回多个根；
  // root 只用于树渲染，flat 包含全部窗口的节点，否则其它窗口的控件永远定位不到
  roots: IUiNode[]
  flat: IUiNode[]
  compressed: boolean
  createdAt: number
  // 界面 XML 的短指纹，用于判断两帧是否完全一致，省掉逐节点比对
  fingerprint: string
  // 输入类操作后坐标可能已失效：保留快照供 diff 使用，但默认拒绝按索引点击
  stale: boolean
  staleReason: string
}

export interface IFrame {
  at: number
  keys: { [key: string]: true }
  nodes: { key: string; node: IUiNode }[]
}

const SNAPSHOT_TTL = 60 * 1000
export const SNAPSHOT_TTL_MS = SNAPSHOT_TTL
const snapshots: { [deviceId: string]: ISnapshot } = {}
// 输入类操作会作废旧快照，但保留上一帧的节点签名，用于比对新界面
const lastFrames: { [deviceId: string]: IFrame } = {}
// 最近几帧快照按 id 存档，供 diffFrom 对照（只留 4 帧，避免内存膨胀）
const history: { [snapshotId: string]: { at: number; frame: IFrame } } = {}
const HISTORY_LIMIT = 4

function attr(el: Element, name: string) {
  const val = el.getAttribute(name)

  return val === null || val === undefined ? '' : val
}

function parseBounds(el: Element): number[] {
  const match = attr(el, 'bounds').match(
    /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/
  )
  if (!match) {
    return [0, 0, 0, 0]
  }

  return [1, 2, 3, 4].map((i) => parseInt(match[i], 10))
}

function toBool(val: string) {
  return val === 'true'
}

function hasArea(rect: number[]) {
  return rect[2] > rect[0] && rect[3] > rect[1]
}

/**
 * 求两个矩形的交集。uiautomator 对横向/纵向滚动容器的子节点会给出越界 bounds
 * （典型是 left > right，如 [1924,458][1900,490]），直接拿 center 点击会点到容器外，
 * 所以这里与父容器（窗口）求交，只保留真正可见的部分。
 */
function intersect(rect: number[], container: number[]) {
  const left = Math.max(rect[0], container[0])
  const top = Math.max(rect[1], container[1])
  const right = Math.min(rect[2], container[2])
  const bottom = Math.min(rect[3], container[3])
  if (right <= left || bottom <= top) {
    return null
  }

  return [left, top, right, bottom]
}

function centerOf(rect: number[]): number[] {
  return [
    Math.round((rect[0] + rect[2]) / 2),
    Math.round((rect[1] + rect[3]) / 2),
  ]
}

function parseNode(
  el: Element,
  counter: { value: number },
  depth: number,
  container: number[] | null
) {
  const raw = parseBounds(el)
  const rawValid = hasArea(raw)
  // 父容器尺寸为 0（未布局、被压缩合并）时不参与裁剪，否则会把整棵子树误判成不可见
  const clipped =
    rawValid && container && hasArea(container) ? intersect(raw, container) : null
  const visible = rawValid && (!container || !hasArea(container) || !!clipped)
  const bounds = visible ? (clipped || raw) : raw
  const node: IUiNode = {
    i: counter.value++,
    text: attr(el, 'text'),
    desc: attr(el, 'content-desc'),
    id: attr(el, 'resource-id'),
    cls: attr(el, 'class'),
    pkg: attr(el, 'package'),
    clickable: toBool(attr(el, 'clickable')),
    focusable: toBool(attr(el, 'focusable')),
    focused: toBool(attr(el, 'focused')),
    scrollable: toBool(attr(el, 'scrollable')),
    checked: toBool(attr(el, 'checked')),
    selected: toBool(attr(el, 'selected')),
    enabled: attr(el, 'enabled') !== 'false',
    bounds,
    center: centerOf(bounds),
    visible,
    depth,
    children: [],
  }
  if (
    visible &&
    (bounds[0] !== raw[0] ||
      bounds[1] !== raw[1] ||
      bounds[2] !== raw[2] ||
      bounds[3] !== raw[3])
  ) {
    node.rawBounds = raw
  }

  // 子节点的裁剪容器：父容器可见时用父的可见区域，父容器无尺寸时继续沿用祖父
  const childContainer = rawValid && visible ? bounds : container

  for (
    let child = el.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.nodeType === 1) {
      const childEl = child as Element
      if (childEl.tagName === 'node') {
        node.children.push(
          parseNode(childEl, counter, depth + 1, childContainer)
        )
      }
    }
  }

  return node
}

export function flatten(nodes: IUiNode[]): IUiNode[] {
  const ret: IUiNode[] = []
  const walk = (list: IUiNode[]) => {
    for (let i = 0, len = list.length; i < len; i++) {
      const node = list[i]
      ret.push(node)
      walk(node.children)
    }
  }
  walk(nodes)

  return ret
}

export function snapshotFingerprint(xml: string) {
  return createHash('sha1').update(xml).digest('hex').slice(0, 12)
}

export function parseSnapshot(
  deviceId: string,
  xml: string,
  compressed: boolean,
  // transient=true：只解析不落库。用于「设备端裁剪」的实验路径，
  // 这种树是稀疏的，不能覆盖内部用于定位的完整快照
  options: { transient?: boolean } = {}
): ISnapshot {
  const existing = getSnapshot(deviceId)
  if (existing && existing.xml === xml && existing.compressed === compressed) {
    // XML 完全一致说明界面没有变化，之前的 stale 标记可以撤销
    existing.stale = false
    existing.staleReason = ''
    return existing
  }

  let doc: any
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml')
  } catch (err) {
    throw new McpError(
      'DUMP_FAILED',
      `UI 树解析失败：${err instanceof Error ? err.message : String(err)}`
    )
  }

  const hierarchies = doc.getElementsByTagName('hierarchy')
  const roots: IUiNode[] = []

  if (hierarchies.length) {
    const counter = { value: 0 }
    for (
      let child = hierarchies[0].firstChild;
      child !== null;
      child = child.nextSibling
    ) {
      if (child.nodeType === 1 && (child as Element).tagName === 'node') {
        roots.push(parseNode(child as Element, counter, 0, null))
      }
    }
  }

  const snapshot: ISnapshot = {
    id: randomBytes(8).toString('hex'),
    deviceId,
    xml,
    root: roots[0] || null,
    roots,
    flat: flatten(roots),
    compressed,
    createdAt: Date.now(),
    fingerprint: snapshotFingerprint(xml),
    stale: false,
    staleReason: '',
  }

  if (!options.transient) {
    snapshots[deviceId] = snapshot
    rememberSnapshot(snapshot)
  }

  return snapshot
}
function frameOf(snapshot: ISnapshot): IFrame {
  const keys: { [key: string]: true } = {}
  const nodes: { key: string; node: IUiNode }[] = []
  for (let i = 0; i < snapshot.flat.length; i++) {
    const node = snapshot.flat[i]
    const key = `${node.cls}\u0001${node.text}\u0001${node.desc}\u0001${node.id}\u0001${node.bounds.join(',')}`
    keys[key] = true
    nodes.push({ key, node })
  }

  return { at: snapshot.createdAt, keys, nodes }
}

function rememberSnapshot(snapshot: ISnapshot) {
  if (history[snapshot.id]) {
    return
  }
  history[snapshot.id] = { at: Date.now(), frame: frameOf(snapshot) }

  const ids = Object.keys(history)
  if (ids.length > HISTORY_LIMIT) {
    ids
      .sort((a, b) => history[a].at - history[b].at)
      .slice(0, ids.length - HISTORY_LIMIT)
      .forEach((id) => delete history[id])
  }
}

export interface ISnapshotDiff {
  available: boolean
  changed: boolean
  appeared: IUiNode[]
  disappeared: IUiNode[]
}

// 与指定的历史快照对比，只返回新增/消失的节点，便于判断「点了之后界面到底变了什么」
export function diffSnapshot(
  fromId: string,
  current: ISnapshot,
  limit = 40
): ISnapshotDiff {
  const from = history[fromId]
  if (!from) {
    return { available: false, changed: false, appeared: [], disappeared: [] }
  }

  const currentFrame = frameOf(current)
  const appeared = currentFrame.nodes
    .filter((item) => !from.frame.keys[item.key])
    .map((item) => item.node)
  const disappeared = from.frame.nodes
    .filter((item) => !currentFrame.keys[item.key])
    .map((item) => item.node)

  return {
    available: true,
    changed: appeared.length > 0 || disappeared.length > 0,
    appeared: appeared.slice(0, limit),
    disappeared: disappeared.slice(0, limit),
  }
}

export function getSnapshot(deviceId: string): ISnapshot | null {
  const snapshot = snapshots[deviceId]
  if (!snapshot) {
    return null
  }
  if (Date.now() - snapshot.createdAt > SNAPSHOT_TTL) {
    delete snapshots[deviceId]
    return null
  }

  return snapshot
}

export function requireSnapshot(
  deviceId: string,
  id: string,
  options: { allowStale?: boolean } = {}
): ISnapshot {
  const snapshot = getSnapshot(deviceId)
  if (!snapshot || !snapshot.root) {
    throw new McpError(
      'STALE_SNAPSHOT',
      '快照已失效，请重新调用 aya_ui_dump 获取新的 snapshotId'
    )
  }
  if (snapshot.id !== id) {
    throw new McpError(
      'STALE_SNAPSHOT',
      `snapshotId 不匹配（当前为 ${snapshot.id}），请用最新快照的节点索引`,
      { snapshotId: snapshot.id }
    )
  }
  if (snapshot.stale && options.allowStale !== true) {
    throw new McpError(
      'STALE_SNAPSHOT',
      `快照已过期（${snapshot.staleReason || '界面已变化'}），节点坐标可能不再有效；请重新 aya_ui_dump，或传 allowStale:true 强制按旧坐标点击`,
      { snapshotId: snapshot.id, deviceId: snapshot.deviceId, stale: true }
    )
  }

  return snapshot
}

// 输入类操作后不立刻删快照：保留节点签名用于 diff，同时标记为过期
export function markSnapshotStale(deviceId: string, reason = '输入操作后界面已变化') {
  const snapshot = snapshots[deviceId]
  if (!snapshot) {
    return
  }
  saveFrame(deviceId)
  snapshot.stale = true
  snapshot.staleReason = reason
}

export function getSnapshotMeta(deviceId: string) {
  const snapshot = getSnapshot(deviceId)
  if (!snapshot) {
    return null
  }

  return {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    ageMs: Date.now() - snapshot.createdAt,
    stale: snapshot.stale,
    staleReason: snapshot.staleReason,
    total: snapshot.flat.length,
  }
}

export function invalidateSnapshot(deviceId?: string) {
  if (deviceId) {
    saveFrame(deviceId)
    delete snapshots[deviceId]
    return
  }

  Object.keys(snapshots).forEach((key) => {
    saveFrame(key)
    delete snapshots[key]
  })
}

function nodeKey(node: IUiNode) {
  return `${node.cls}\u0001${node.text}\u0001${node.desc}\u0001${node.id}\u0001${node.bounds.join(',')}`
}

function saveFrame(deviceId: string) {
  const snapshot = snapshots[deviceId]
  if (!snapshot || !snapshot.flat.length) {
    return
  }

  lastFrames[deviceId] = frameOf(snapshot)
}

export function dropSnapshot(deviceId: string) {
  delete snapshots[deviceId]
}

export function takeLastFrame(deviceId: string): IFrame | null {
  const frame = lastFrames[deviceId] || null
  delete lastFrames[deviceId]

  return frame
}

export interface IFrameDiff {
  comparable: boolean
  changed: boolean
  appeared: IUiNode[]
  disappeared: IUiNode[]
}

export function diffFrame(
  frame: IFrame | null,
  current: IUiNode[]
): IFrameDiff {
  if (!frame) {
    return { comparable: false, changed: false, appeared: [], disappeared: [] }
  }

  const currentKeys: { [key: string]: true } = {}
  for (let i = 0; i < current.length; i++) {
    currentKeys[nodeKey(current[i])] = true
  }

  const appeared = current.filter((node) => !frame.keys[nodeKey(node)])
  const disappeared = frame.nodes
    .filter((item) => !currentKeys[item.key])
    .map((item) => item.node)

  return {
    comparable: true,
    changed: appeared.length > 0 || disappeared.length > 0,
    appeared,
    disappeared,
  }
}
