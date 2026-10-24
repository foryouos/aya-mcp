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
  // 能定位但坐标可能不可用时的提示（例如节点已滚出容器），不阻断执行
  warning?: string
}

// 按文本/资源 id 定位时只允许复用极新的快照，
// 否则会拿几十秒前的坐标去点一个早已切走的界面
const SELECTOR_SNAPSHOT_TTL = 1000

async function ensureSnapshot(
  deviceId: string,
  mode: 'auto' | 'snapshot' | 'dump' = 'auto'
): Promise<ISnapshot> {
  const existing = getSnapshot(deviceId)

  // snapshot：显式要求复用现有快照，一次 dump 都不做（最快，但坐标可能已过时）
  if (mode === 'snapshot' && existing && existing.root) {
    return existing
  }

  if (mode === 'auto' && existing && existing.root) {
    const fresh = Date.now() - existing.createdAt <= SELECTOR_SNAPSHOT_TTL

    // 过期不删：交给 dump 复核，若界面完全一致 parseSnapshot 会直接复用同一快照
    if (fresh && !existing.stale) {
      return existing
    }
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
      { snapshotId: snapshot.id, deviceId: snapshot.deviceId, total: snapshot.flat.length }
    )
  }

  return node
}

function shortOf(value: string) {
  const slash = value.lastIndexOf('/')

  return slash >= 0 ? value.slice(slash + 1) : value
}

/**
 * 定位失败时的诊断：找出「差不多」的控件。
 * 之前只回一句"没找到"，无法区分「id 写错」「控件存在但被滚动容器裁掉」「控件还没渲染」，
 * 每次都要多花两三轮 dump 去猜，这里直接把候选和可见性回给调用方。
 */
function diagnoseMiss(
  flat: IUiNode[],
  query: { text?: unknown; id?: unknown; desc?: unknown }
) {
  const wantId = query.id ? shortOf(String(query.id)).toLowerCase() : ''
  const wantText = query.text ? String(query.text).trim().toLowerCase() : ''
  const wantDesc = query.desc ? String(query.desc).trim().toLowerCase() : ''
  const scored: { score: number; node: IUiNode }[] = []

  for (let i = 0; i < flat.length; i++) {
    const node = flat[i]
    let score = 0
    if (wantId && node.id) {
      const short = shortOf(node.id).toLowerCase()
      if (short === wantId) {
        score = 3
      } else if (short.includes(wantId) || wantId.includes(short)) {
        score = 2
      }
    }
    if (!score && wantText && node.text) {
      const text = node.text.trim().toLowerCase()
      if (text === wantText) {
        score = 3
      } else if (text.includes(wantText) || wantText.includes(text)) {
        score = 2
      }
    }
    if (!score && wantDesc && node.desc) {
      const desc = node.desc.trim().toLowerCase()
      if (desc === wantDesc) {
        score = 3
      } else if (desc.includes(wantDesc) || wantDesc.includes(desc)) {
        score = 2
      }
    }
    if (score) {
      // 可见的候选优先，避免把屏幕外的同名节点推荐给调用方
      scored.push({ score: score + (node.visible ? 0.5 : 0), node })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.node.i - b.node.i)
  const near = scored.slice(0, 5)
  const invisibleNear = near.filter((item) => !item.node.visible).length

  return {
    nearMatches: near.map((item) => brief(item.node)),
    invisibleNear,
    invisibleTotal: flat.filter((node) => !node.visible).length,
    visibleTotal: flat.filter((node) => node.visible).length,
  }
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
    const snapshot = requireSnapshot(deviceId, args.snapshotId, {
      allowStale: args.allowStale === true,
    })
    const node = lookupIndex(snapshot, args.nodeIndex)

    return {
      deviceId,
      point: [node.center[0], node.center[1]],
      node,
      matchedCount: 1,
      clickedIndex: 0,
      candidates: [],
      warning: node.visible
        ? undefined
        : `节点 ${node.i} 当前不可见（被滚动容器裁掉或在屏幕外），center 落在容器之外，操作可能无效；先滑动到可见区域再试`,
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

  const mode =
    args.resolve === 'snapshot' || args.resolve === 'dump'
      ? args.resolve
      : 'auto'
  const snapshot = await ensureSnapshot(deviceId, mode)
  const query = { text: args.text, id: args.id, desc: args.desc }
  // 默认只认可见节点：屏幕外节点的 center 点在容器外面，点了也没有效果
  const includeInvisible = args.includeInvisible === true
  const matched = findMatches(snapshot.flat, {
    text: args.text,
    id: args.id,
    desc: args.desc,
    exact: args.exact !== false,
    visibleOnly: !includeInvisible,
  })

  if (!matched.length) {
    const diagnosis = diagnoseMiss(snapshot.flat, query)
    const ageMs = Date.now() - snapshot.createdAt
    let hint = ''
    if (diagnosis.invisibleNear) {
      hint = `匹配到的控件当前不可见（被滚动容器裁掉或在屏幕外），先滑动到可见区域，或传 includeInvisible:true 强制按越界坐标点击`
    } else if (diagnosis.nearMatches.length) {
      hint = `没有精确匹配，nearMatches 是相近的控件：可改用完整的 text/id，或传 exact:false 做子串匹配`
    } else {
      hint = `界面里没有任何相近控件，可能还没渲染完成：先 aya_wait_for 等一下，或 aya_ui_dump 看当前界面`
    }
    if (ageMs > 2000) {
      hint += `；另外快照已产生 ${ageMs}ms，界面可能已经变化`
    }

    throw new McpError('NO_MATCH', hint, {
      snapshotId: snapshot.id,
      deviceId: snapshot.deviceId,
      snapshotAgeMs: ageMs,
      query,
      total: snapshot.flat.length,
      visibleTotal: diagnosis.visibleTotal,
      invisibleTotal: diagnosis.invisibleTotal,
      nearMatches: diagnosis.nearMatches,
    })
  }

  const index = typeof args.index === 'number' && args.index >= 0 ? args.index : 0
  if (index >= matched.length) {
    throw new McpError(
      'AMBIGUOUS_MATCH',
      `共匹配 ${matched.length} 个控件，index ${index} 超出范围`,
      {
        snapshotId: snapshot.id,
        deviceId: snapshot.deviceId,
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
