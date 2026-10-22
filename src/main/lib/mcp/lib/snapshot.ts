import { randomBytes } from 'node:crypto'
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
}

export interface IFrame {
  at: number
  keys: { [key: string]: true }
  nodes: { key: string; node: IUiNode }[]
}

const SNAPSHOT_TTL = 60 * 1000
const snapshots: { [deviceId: string]: ISnapshot } = {}
// 输入类操作会作废旧快照，但保留上一帧的节点签名，用于比对新界面
const lastFrames: { [deviceId: string]: IFrame } = {}

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

export function parseSnapshot(
  deviceId: string,
  xml: string,
  compressed: boolean
): ISnapshot {
  const existing = getSnapshot(deviceId)
  if (existing && existing.xml === xml && existing.compressed === compressed) {
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
  }

  snapshots[deviceId] = snapshot

  return snapshot
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

export function requireSnapshot(deviceId: string, id: string): ISnapshot {
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

  return snapshot
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

  const keys: { [key: string]: true } = {}
  const nodes: { key: string; node: IUiNode }[] = []
  for (let i = 0; i < snapshot.flat.length; i++) {
    const node = snapshot.flat[i]
    const key = nodeKey(node)
    keys[key] = true
    nodes.push({ key, node })
  }

  lastFrames[deviceId] = { at: snapshot.createdAt, keys, nodes }
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
