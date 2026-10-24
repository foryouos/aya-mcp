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
  bounds: number[]
  center: number[]
  depth: number
  children: IUiNode[]
}

export interface ISnapshot {
  id: string
  deviceId: string
  xml: string
  root: IUiNode | null
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

function parseNode(el: Element, counter: { value: number }, depth: number) {
  const bounds = parseBounds(el)
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
    center: [
      Math.round((bounds[0] + bounds[2]) / 2),
      Math.round((bounds[1] + bounds[3]) / 2),
    ],
    depth,
    children: [],
  }

  for (
    let child = el.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.nodeType === 1) {
      const childEl = child as Element
      if (childEl.tagName === 'node') {
        node.children.push(parseNode(childEl, counter, depth + 1))
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
  compressed: boolean
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
  let root: IUiNode | null = null

  if (hierarchies.length) {
    const counter = { value: 0 }
    for (
      let child = hierarchies[0].firstChild;
      child !== null;
      child = child.nextSibling
    ) {
      if (child.nodeType === 1 && (child as Element).tagName === 'node') {
        const parsed = parseNode(child as Element, counter, 0)
        if (!root) {
          root = parsed
        }
      }
    }
  }

  const snapshot: ISnapshot = {
    id: randomBytes(8).toString('hex'),
    deviceId,
    xml,
    root,
    flat: root ? flatten([root]) : [],
    compressed,
    createdAt: Date.now(),
    fingerprint: snapshotFingerprint(xml),
    stale: false,
    staleReason: '',
  }

  snapshots[deviceId] = snapshot
  rememberSnapshot(snapshot)

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
