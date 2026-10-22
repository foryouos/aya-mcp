import * as adb from '../../adb'
import { withDeviceQueue } from '../lib/dump'
import { resolveTarget } from '../lib/target'
import { afterInput } from '../lib/action'
import { brief } from '../lib/ui'
import { assertShellOk } from '../lib/shellCheck'
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
    description: '操作后等待界面稳定的毫秒数，默认 300',
  },
}

async function tapHandler(args: any) {
  const target = await resolveTarget(args)
  const x = target.point[0]
  const y = target.point[1]

  const output = await withDeviceQueue(target.deviceId, () =>
    adb.inputTap(target.deviceId, x, y)
  )
  assertShellOk(output, 'aya_tap')
  const settledMs = await afterInput(
    target.deviceId,
    typeof args.settle === 'number' ? args.settle : 300
  )

  return jsonResult({
    ok: true,
    deviceId: target.deviceId,
    clicked: true,
    point: target.point,
    matchedCount: target.matchedCount,
    clickedIndex: target.clickedIndex,
    node: target.node ? brief(target.node) : null,
    candidates: target.candidates,
    settledMs,
  })
}

const tap: McpTool = {
  name: 'aya_tap',
  description:
    '点击屏幕。可用 {x,y} 指定坐标，用 {nodeIndex,snapshotId} 精确点击快照中的节点，或用 {text,id,desc} 按控件定位（服务端自动计算中心坐标）。返回实际点击坐标与命中节点。',
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
    '按控件文本点击（等价 aya_tap + text）。默认精确匹配，找不到时可用 exact:false 做子串匹配；多个同名控件用 index 指定。',
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
