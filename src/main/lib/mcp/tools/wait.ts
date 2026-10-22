import { resolveDeviceId } from '../lib/device'
import { dumpFast, invalidateDump } from '../lib/dump'
import { findMatches, labelNode, pickActionable } from '../lib/ui'
import { parseSnapshot } from '../lib/snapshot'
import { sleep } from '../lib/action'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return fallback
  }

  return Math.min(Math.max(Math.floor(num), min), max)
}

const waitFor: McpTool = {
  name: 'aya_wait_for',
  description:
    '轮询等待某个控件出现（或消失），命中即返回，超时也返回当前界面。用于等加载完成、等广告结束、确认弹窗已关闭；比反复调用 aya_ui_dump 省往返。条件用 text/id/desc 子串匹配，gone:true 表示等它消失。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
      text: { type: 'string', description: '等待出现的文本（子串匹配）' },
      id: { type: 'string', description: '等待出现的 resource-id（子串匹配）' },
      desc: {
        type: 'string',
        description: '等待出现的 content-desc（子串匹配）',
      },
      gone: {
        type: 'boolean',
        description: 'true 时等待控件消失，默认 false（等它出现）',
      },
      timeout: {
        type: 'number',
        description: '最长等待毫秒数，默认 5000，上限 15000',
      },
      interval: {
        type: 'number',
        description: '两次检查之间的间隔毫秒数，默认 250',
      },
      maxNodes: {
        type: 'number',
        description: '超时后回传的可交互节点上限，默认 40',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const text = args.text ? String(args.text) : ''
    const id = args.id ? String(args.id) : ''
    const desc = args.desc ? String(args.desc) : ''

    if (!text && !id && !desc) {
      throw new McpError(
        'INVALID_ARGS',
        '至少提供 text / id / desc 之一作为等待条件'
      )
    }

    const gone = args.gone === true
    const timeout = clamp(args.timeout, 100, 15000, 5000)
    const interval = clamp(args.interval, 100, 2000, 250)
    const maxNodes = clamp(args.maxNodes, 1, 200, 40)
    const started = Date.now()

    let attempts = 0
    let matchedNode: any = null
    let matched = false
    let snapshotId = ''
    let nodes: any[] = []

    for (;;) {
      attempts++
      // 绕过 dump 的 1 秒缓存，保证看到的是最新界面
      invalidateDump(deviceId)
      const dump = await dumpFast(deviceId)
      const snapshot = parseSnapshot(deviceId, dump.xml, true)
      snapshotId = snapshot.id

      const hits = findMatches(snapshot.flat, {
        text,
        id,
        desc,
        exact: false,
      })

      const hit = gone ? hits.length === 0 : hits.length > 0
      if (hit) {
        matched = true
        matchedNode = hits.length ? labelNode(hits[0]) : null
        break
      }

      // 超时时把最后一帧的可交互节点带回去，便于直接纠正下一步
      nodes = pickActionable(snapshot.flat, maxNodes).nodes

      if (Date.now() - started >= timeout) {
        break
      }

      await sleep(interval)
    }

    return jsonResult({
      ok: true,
      deviceId,
      matched,
      gone,
      condition: { text, id, desc },
      attempts,
      waitedMs: Date.now() - started,
      timeoutMs: timeout,
      snapshotId,
      node: matchedNode,
      nodes: matched ? [] : nodes,
      hint: matched
        ? ''
        : '等待超时。若目标是视频/游戏画面里的控件，uiautomator 可能读不到，改用 aya_screencap',
    })
  },
}

export default [waitFor]
