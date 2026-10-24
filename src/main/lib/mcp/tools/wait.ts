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
        description:
          '两次检查之间的间隔毫秒数，默认 150；实际间隔会自适应放大到上界，减少无谓 dump',
      },
      stableFor: {
        type: 'number',
        description:
          '不按控件等待，改为等待界面「稳定」：连续 stableFor 毫秒内界面指纹不变即返回（用于等动画/加载结束），如 500',
      },
      maxNodes: {
        type: 'number',
        description: '超时后回传的可交互节点上限，默认 20',
      },
      withUi: {
        type: 'boolean',
        description: '超时时是否回传可交互节点，默认 true；只需知道是否命中时传 false 更省',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const text = args.text ? String(args.text) : ''
    const id = args.id ? String(args.id) : ''
    const desc = args.desc ? String(args.desc) : ''
    const stableFor = clamp(args.stableFor, 0, 10000, 0)

    if (!text && !id && !desc && !stableFor) {
      throw new McpError(
        'INVALID_ARGS',
        '至少提供 text / id / desc 之一作为等待条件，或传 stableFor 等待界面稳定'
      )
    }

    const gone = args.gone === true
    const timeout = clamp(args.timeout, 100, 30000, 5000)
    const interval = clamp(args.interval, 100, 2000, 150)
    const maxNodes = clamp(args.maxNodes, 1, 200, 20)
    const withUi = args.withUi !== false
    const started = Date.now()

    let attempts = 0
    let matchedNode: any = null
    let matched = false
    let snapshotId = ''
    let fingerprint = ''
    let nodes: any[] = []
    let stableSince = 0
    let currentInterval = interval
    let dumpMs = 0
    let totalDumpMs = 0

    for (;;) {
      attempts++
      // 绕过 dump 的 1 秒缓存，保证看到的是最新界面
      invalidateDump(deviceId)
      const dump = await dumpFast(deviceId)
      dumpMs = dump.ms
      totalDumpMs += dump.ms
      const snapshot = parseSnapshot(deviceId, dump.xml, true)
      snapshotId = snapshot.id

      if (stableFor) {
        // 稳定模式：指纹连续不变超过 stableFor 即认为动画/加载结束
        if (snapshot.fingerprint === fingerprint) {
          if (Date.now() - stableSince >= stableFor) {
            matched = true
            break
          }
        } else {
          fingerprint = snapshot.fingerprint
          stableSince = Date.now()
        }
      } else {
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
      }

      // 超时时把最后一帧的可交互节点带回去，便于直接纠正下一步
      if (withUi) {
        nodes = pickActionable(snapshot.flat, maxNodes).nodes
      }

      const elapsed = Date.now() - started
      if (elapsed >= timeout) {
        break
      }

      // 自适应轮询：前几次密集检查（抓瞬时弹窗），之后逐步放大间隔
      await sleep(currentInterval)
      currentInterval = Math.min(Math.round(currentInterval * 1.5), 600)
    }

    return jsonResult({
      ok: true,
      deviceId,
      matched,
      gone: stableFor ? false : gone,
      mode: stableFor ? 'stable' : 'selector',
      condition: { text, id, desc, stableFor },
      attempts,
      waitedMs: Date.now() - started,
      timeoutMs: timeout,
      dumpMs,
      totalDumpMs,
      stableMs: stableFor && matched ? Date.now() - stableSince : 0,
      snapshotId,
      fingerprint,
      node: matchedNode,
      nodes: matched || !withUi ? [] : nodes,
      hint: matched
        ? ''
        : '等待超时。若目标是视频/游戏画面里的控件，uiautomator 可能读不到，改用 aya_screencap 或 aya_webview_snapshot',
    })
  },
}

export default [waitFor]
