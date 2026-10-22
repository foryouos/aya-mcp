import { nativeImage } from 'electron'
import * as adb from '../../adb'
import { resolveDeviceId } from '../lib/device'
import { dumpFast, withDeviceQueue } from '../lib/dump'
import { parseSnapshot } from '../lib/snapshot'
import { brief, compactTree, findMatches } from '../lib/ui'
import { jsonResult, textResult } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const screencap: McpTool = {
  name: 'aya_screencap',
  description:
    '截取设备当前屏幕并直接返回 PNG 图片。maxWidth 控制缩放后的宽度（默认 900），用于降低图片体积。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      maxWidth: {
        type: 'number',
        description: '缩放后的最大宽度，默认 900，传 0 表示不缩放',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const base64 = await adb.screencap(deviceId)
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    const size = image.getSize()
    const maxWidth = typeof args.maxWidth === 'number' ? args.maxWidth : 900

    let output = image
    let scale = 1
    if (maxWidth > 0 && size.width > maxWidth) {
      output = image.resize({ width: Math.round(maxWidth), quality: 'good' })
      scale = maxWidth / size.width
    }

    const data = output.toPNG().toString('base64')
    const scaled = output.getSize()

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            deviceId,
            width: size.width,
            height: size.height,
            imageWidth: scaled.width,
            imageHeight: scaled.height,
            scale,
            note: '图片可能被缩放；点击坐标请使用 aya_ui_dump 返回的 center（设备像素）',
          }),
        },
        {
          type: 'image' as const,
          data,
          mimeType: 'image/png',
        },
      ],
    }
  },
}

const uiDump: McpTool = {
  name: 'aya_ui_dump',
  description:
    '获取当前界面的 UI 层级树（紧凑 JSON，每个节点含 bounds 与 center 坐标）。可用 text/id/desc/clickableOnly 过滤，用 depth/maxNodes 限制体积。返回的 snapshotId 与节点 i 可用于 aya_tap 的 nodeIndex 精确定位。注意：任何输入类工具（点击/滑动/按键/输入）执行后快照即失效，需要重新 dump。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      text: { type: 'string', description: '按文本过滤（子串匹配）' },
      id: { type: 'string', description: '按 resource-id 过滤（子串匹配）' },
      desc: { type: 'string', description: '按 content-desc 过滤（子串匹配）' },
      clickableOnly: {
        type: 'boolean',
        description: '仅返回可点击节点',
      },
      depth: {
        type: 'number',
        description: '最大返回层级深度，默认 12',
      },
      maxNodes: {
        type: 'number',
        description: '最多返回节点数，默认 300',
      },
      compressed: {
        type: 'boolean',
        description: '使用 uiautomator --compressed（默认 true，节点更少更快）',
      },
      raw: {
        type: 'boolean',
        description: '直接返回原始 XML（体积大，节点索引不可用）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const compressed = args.compressed !== false
    let xml = ''
    let source = 'fast'

    if (compressed) {
      const dump = await dumpFast(deviceId)
      xml = dump.xml
      source = dump.source
    } else {
      xml = await withDeviceQueue(deviceId, () =>
        adb.dumpWindowHierarchy(deviceId)
      )
      source = 'uncompressed'
    }

    const snapshot = parseSnapshot(deviceId, xml, compressed)
    const raw = args.raw === true
    const total = snapshot.flat.length

    if (raw) {
      return jsonResult({
        ok: true,
        deviceId,
        snapshotId: snapshot.id,
        source,
        indexable: false,
        total,
        xml,
      })
    }

    const depth =
      typeof args.depth === 'number' && args.depth > 0 ? args.depth : 12
    const maxNodes =
      typeof args.maxNodes === 'number' && args.maxNodes > 0
        ? args.maxNodes
        : 300
    const hasFilter = !!(args.text || args.id || args.desc || args.clickableOnly)

    if (hasFilter) {
      const matched = findMatches(snapshot.flat, {
        text: args.text,
        id: args.id,
        desc: args.desc,
        clickableOnly: !!args.clickableOnly,
        exact: false,
      })
      const limited = matched.slice(0, maxNodes)

      return jsonResult({
        ok: true,
        deviceId,
        snapshotId: snapshot.id,
        source,
        indexable: true,
        total,
        matched: matched.length,
        returned: limited.length,
        truncated: matched.length > limited.length,
        nodes: limited.map(brief),
      })
    }

    if (!snapshot.root) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: 'DUMP_FAILED',
              message: '未解析到任何节点，界面可能尚未就绪',
            },
          },
          null,
          2
        )
      )
    }

    const tree = compactTree(snapshot.root, depth, maxNodes)

    return jsonResult({
      ok: true,
      deviceId,
      snapshotId: snapshot.id,
      source,
      indexable: true,
      total,
      returned: tree.count,
      truncated: tree.truncated,
      nodes: tree.nodes,
    })
  },
}

export default [screencap, uiDump]
