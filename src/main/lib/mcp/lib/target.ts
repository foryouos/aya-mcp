import { McpError } from './result'
import { resolveDeviceId } from './device'
import { dumpFast } from './dump'
import {
  getSnapshot,
  IUiNode,
  ISnapshot,
  parseSnapshot,
  requireSnapshot,
} from './snapshot'
import { brief, findMatches } from './ui'

export interface ITarget {
  deviceId: string
  point: [number, number]
  node: IUiNode | null
  matchedCount: number
  clickedIndex: number
  candidates: any[]
}

async function ensureSnapshot(deviceId: string): Promise<ISnapshot> {
  const existing = getSnapshot(deviceId)
  if (existing && existing.root) {
    return existing
  }

  const dumped = await dumpFast(deviceId)

  return parseSnapshot(deviceId, dumped.xml, true)
}

function lookupIndex(snapshot: ISnapshot, index: number) {
  const node = snapshot.flat.find((item) => item.i === index)

  if (!node) {
    throw new McpError(
      'NO_MATCH',
      `快照中不存在节点索引 ${index}`,
      { snapshotId: snapshot.id, total: snapshot.flat.length }
    )
  }

  return node
}

export async function resolveTarget(args: any): Promise<ITarget> {
  const deviceId = await resolveDeviceId(args.deviceId)

  if (typeof args.nodeIndex === 'number') {
    if (typeof args.snapshotId !== 'string' || !args.snapshotId) {
      throw new McpError(
        'INVALID_ARGS',
        '使用 nodeIndex 时必须同时提供 aya_ui_dump 返回的 snapshotId'
      )
    }
    const snapshot = requireSnapshot(deviceId, args.snapshotId)
    const node = lookupIndex(snapshot, args.nodeIndex)

    return {
      deviceId,
      point: [node.center[0], node.center[1]],
      node,
      matchedCount: 1,
      clickedIndex: 0,
      candidates: [],
    }
  }

  if (typeof args.x === 'number' && typeof args.y === 'number') {
    return {
      deviceId,
      point: [Math.round(args.x), Math.round(args.y)],
      node: null,
      matchedCount: 0,
      clickedIndex: 0,
      candidates: [],
    }
  }

  const hasSelector = args.text || args.id || args.desc
  if (!hasSelector) {
    throw new McpError(
      'INVALID_ARGS',
      '需提供 {x,y}、{nodeIndex,snapshotId} 或 {text,id,desc} 之一来定位点击位置'
    )
  }

  const snapshot = await ensureSnapshot(deviceId)
  const matched = findMatches(snapshot.flat, {
    text: args.text,
    id: args.id,
    desc: args.desc,
    exact: args.exact !== false,
  })

  if (!matched.length) {
    throw new McpError(
      'NO_MATCH',
      '没有找到匹配的控件，可尝试 exact:false 做模糊匹配，或先用 aya_ui_dump 查看节点',
      { snapshotId: snapshot.id, query: { text: args.text, id: args.id, desc: args.desc } }
    )
  }

  const index = typeof args.index === 'number' && args.index >= 0 ? args.index : 0
  if (index >= matched.length) {
    throw new McpError(
      'AMBIGUOUS_MATCH',
      `共匹配 ${matched.length} 个控件，index ${index} 超出范围`,
      {
        snapshotId: snapshot.id,
        matchedCount: matched.length,
        candidates: matched.slice(0, 5).map(brief),
      }
    )
  }

  const node = matched[index]

  return {
    deviceId,
    point: [node.center[0], node.center[1]],
    node,
    matchedCount: matched.length,
    clickedIndex: index,
    candidates: matched.slice(0, 5).map(brief),
  }
}
