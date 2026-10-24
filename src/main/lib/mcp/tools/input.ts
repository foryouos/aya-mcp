import { captureUi, performTap, resolveSettle, resolveWithUi } from '../lib/action'
import { brief } from '../lib/ui'
import { jsonResult } from '../lib/result'
import { McpTool } from './types'

const targetProps = {
  deviceId: {
    type: 'string',
    description: '设备 id。省略时使用 AYA 当前选中设备',
  },
  x: { type: 'number', description: '点击的 X 坐标（设备像素）' },
  y: { type: 'number', description: '点击的 Y 坐标（设备像素）' },
  nodeIndex: {
    type: 'number',
    description: 'aya_ui_dump 返回的节点 i，必须配合 snapshotId 使用',
  },
  snapshotId: {
    type: 'string',
    description: 'aya_ui_dump 返回的 snapshotId，用于校验节点索引未过期',
  },
  text: { type: 'string', description: '按控件文本定位' },
  id: { type: 'string', description: '按 resource-id 定位' },
  desc: { type: 'string', description: '按 content-desc 定位' },
  index: {
    type: 'number',
    description: '匹配到多个控件时选择第几个，默认 0',
  },
  exact: {
    type: 'boolean',
    description: '是否精确匹配，默认 true；false 时按子串匹配',
  },
  settle: {
    type: 'number',
    description: '点击后到抓取界面的等待毫秒数，默认 120（withUi:false 时 300）',
  },
  withUi: {
    type: ['boolean', 'string'],
    description:
      '点击后是否立即抓取新界面返回。默认 "auto"（等同 true）：一次调用即可看到点击结果，避免再调 aya_ui_dump 期间控件已自动隐藏；传 false 可省掉 0.3-1s',
  },
  uiMaxNodes: {
    type: 'number',
    description: '回传的可交互节点上限，默认 60',
  },
  allowStale: {
    type: 'boolean',
    description:
      '按 nodeIndex 点击时是否允许使用已过期的快照坐标，默认 false（过期会要求重新 dump）',
  },
}

async function tapHandler(args: any) {
  const withUi = resolveWithUi(args.withUi, true)
  const settle = resolveSettle(args, withUi ? 120 : 300)
  const started = Date.now()
  const { target, settledMs } = await performTap(args, settle)

  const payload: any = {
    ok: true,
    deviceId: target.deviceId,
    clicked: true,
    point: target.point,
    matchedCount: target.matchedCount,
    clickedIndex: target.clickedIndex,
    node: target.node ? brief(target.node) : null,
    candidates: target.candidates,
    settledMs,
  }

  if (withUi) {
    try {
      payload.ui = await captureUi(target.deviceId, {
        maxNodes: args.uiMaxNodes,
      })
    } catch (err) {
      // 点击已经生效，抓界面失败不能算整体失败
      payload.uiError = err instanceof Error ? err.message : String(err)
    }
  }

 // 端到端耗时：定位 + 点击 + 等待 + 可选抓帧，便于判断瓶颈在哪一段
  payload.totalMs = Date.now() - started

  return jsonResult(payload)
}

const tap: McpTool = {
  name: 'aya_tap',
  description:
    '点击屏幕。可用 {x,y} 指定坐标，用 {nodeIndex,snapshotId} 精确点击快照中的节点，或用 {text,id,desc} 按控件定位。默认点击后立即返回新界面（ui.appeared 是相对点击前新增的控件；ui.nodes 可直接用 nodeIndex+ui.snapshotId 继续点击），适合视频控制栏等会自动隐藏的瞬时控件；只要点击结果可用 withUi:false 关掉。',
  inputSchema: {
    type: 'object',
    properties: targetProps,
    additionalProperties: false,
  },
  write: true,
  handler: tapHandler,
}

const tapText: McpTool = {
  name: 'aya_tap_text',
  description:
    '按控件文本点击（等价 aya_tap + text）。默认精确匹配，找不到时可用 exact:false 做子串匹配；多个同名控件用 index 指定。参数与返回同 aya_tap（含 withUi）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...targetProps,
      text: { type: 'string', description: '要点击的控件文本' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  write: true,
  handler: tapHandler,
}

export default [tap, tapText]
