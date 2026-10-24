import fs from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import * as adb from '../../adb'
import * as base from '../../adb/base'
import * as adbFile from '../../adb/file'
import { resolveDeviceId } from '../lib/device'
import { dumpFast, withDeviceQueue } from '../lib/dump'
import {
  diffSnapshot,
  getSnapshot,
  parseSnapshot,
  SNAPSHOT_TTL_MS,
} from '../lib/snapshot'
import { compactTree, findMatches, projectNode } from '../lib/ui'
import { jsonResult, textResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const screencap: McpTool = {
  name: 'aya_screencap',
  description:
    '截取设备当前屏幕并直接返回图片。默认缩放到宽 900 并编码为 JPEG（quality 72），相比原始 PNG 体积通常小 5-10 倍：只在 uiautomator 读不到内容（视频、游戏、Canvas、相机）时才需要它。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      maxWidth: {
        type: 'number',
        description: '缩放后的最大宽度，默认 900，传 0 表示不缩放',
      },
      format: {
        type: 'string',
        enum: ['jpeg', 'png'],
        description:
          '图片格式。默认 jpeg（体积小）；需要精确像素或透明通道时用 png',
      },
      quality: {
        type: 'number',
        description: 'JPEG 质量 1-100，默认 72；体积敏感时降到 50',
      },
      crop: {
        type: 'object',
        description: '只截取指定区域（设备像素），坐标来自 aya_ui_dump 的 bounds',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      saveTo: {
        type: 'string',
        description:
          '保存到本机路径并只返回路径（不把图片塞进上下文）。看细节但不需要模型读图时用',
      },
      displayId: {
        type: 'number',
        description: '多屏时指定屏幕 id（见 aya_list_displays），默认主屏',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const image = nativeImage.createFromBuffer(
      await screencapBuffer(deviceId, args.displayId)
    )
    const size = image.getSize()
    const maxWidth = typeof args.maxWidth === 'number' ? args.maxWidth : 900

    let output = image
    let scale = 1
    let cropped: any = null

    const crop = args.crop
    if (
      crop &&
      [crop.x, crop.y, crop.width, crop.height].every(
        (value) => typeof value === 'number' && Number.isFinite(value)
      )
    ) {
      const rect = {
        x: Math.max(Math.floor(crop.x), 0),
        y: Math.max(Math.floor(crop.y), 0),
        width: Math.max(Math.floor(crop.width), 1),
        height: Math.max(Math.floor(crop.height), 1),
      }
      output = image.crop(rect)
      cropped = rect
    }

    // 缩放比例相对「裁剪后」的尺寸计算，否则 crop 场景下点击坐标换算会偏
    const sourceWidth = cropped ? cropped.width : size.width
    if (maxWidth > 0 && output.getSize().width > maxWidth) {
      output = output.resize({ width: Math.round(maxWidth), quality: 'good' })
    }
    scale = output.getSize().width / sourceWidth

    const asPng = args.format === 'png'
    const quality = Math.min(
      Math.max(Math.floor(Number(args.quality) || 72), 1),
      100
    )
    const buffer = asPng ? output.toPNG() : output.toJPEG(quality)
    const scaled = output.getSize()

    const meta = {
      ok: true,
      deviceId,
      width: size.width,
      height: size.height,
      imageWidth: scaled.width,
      imageHeight: scaled.height,
      format: asPng ? 'png' : 'jpeg',
      quality: asPng ? null : quality,
      bytes: buffer.length,
      cropped,
      scale,
      note: '图片可能被缩放；点击坐标请使用 aya_ui_dump 返回的 center（设备像素）。优先用 aya_ui_dump / aya_webview_snapshot，截屏只在解析不到控件时使用',
    }

    // 只想留档（贴 bug 单、对比）时走这条路，避免把 base64 塞进模型上下文
    const saveTo = String(args.saveTo || '').trim()
    if (saveTo) {
      const target = path.resolve(saveTo)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer)
      return jsonResult({ ...meta, savedTo: target, note: undefined })
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(meta) },
        {
          type: 'image' as const,
          data: buffer.toString('base64'),
          mimeType: asPng ? 'image/png' : 'image/jpeg',
        },
      ],
    }
  },
}

// displayId 不存在于 IPC 接口里：多屏时在设备端落盘再拉回原始 PNG
async function screencapBuffer(deviceId: string, displayId?: number) {
  if (typeof displayId !== 'number' || !Number.isFinite(displayId)) {
    const base64 = await adb.screencap(deviceId)
    return Buffer.from(base64, 'base64')
  }

  const remote = `/data/local/tmp/aya-screen-${Date.now()}.png`
  try {
    await base.shell(deviceId, `screencap -p -d ${Math.floor(displayId)} ${remote}`)
    return await adbFile.pullFileData(deviceId, remote)
  } finally {
    await base.shell(deviceId, `rm -f ${remote}`).catch(() => '')
  }
}

const uiDump: McpTool = {
  name: 'aya_ui_dump',
  description:
    '获取当前界面的 UI 层级树（紧凑 JSON，每个节点含 bounds 与 center 坐标）。可用 text/id/desc/clickableOnly 过滤，用 depth/maxNodes 限制体积，用 fields 只保留需要的字段，用 cursor 分页。返回的 snapshotId 与节点 i 可用于 aya_tap 的 nodeIndex 精确定位。reuse:true 时不重新 dump、直接复用当前快照（配合 cursor 翻页可反复读取，几乎零耗时）。点击/滑动/按键/输入后快照会被标记过期（对应 nodeIndex 会要求重新 dump）。',
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
        description: '最多返回节点数，默认 100（配合 cursor 分页读取更大的界面）',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          '只返回这些字段（i 始终保留）：text/desc/id/class/bounds/center/clickable/flags。省略返回全部',
      },
      cursor: {
        type: 'number',
        description: '过滤结果的分页偏移（与 maxNodes 配合），返回值里的 nextCursor 为下一页起点',
      },
      reuse: {
        type: 'boolean',
        description:
          '不重新 dump，直接复用当前快照（61 秒内有效）。翻页、重读同一界面时用它可以省掉 0.3-1s',
      },
      diffFrom: {
        type: 'string',
        description:
          '传上一次的 snapshotId，额外返回与那一帧相比新增/消失的节点（最多 40 个）',
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
    let dumpMs = 0

    if (args.reuse === true) {
      const existing = getSnapshot(deviceId)
      if (!existing || !existing.root) {
        throw new McpError(
          'STALE_SNAPSHOT',
          '当前没有可用快照，去掉 reuse 重新 dump 一次'
        )
      }
      return render(deviceId, existing, 'reuse', args, { dumpMs: 0, parseMs: 0 })
    }

    if (compressed) {
      const dump = await dumpFast(deviceId)
      xml = dump.xml
      source = dump.source
      dumpMs = dump.ms
    } else {
      const started = Date.now()
      xml = await withDeviceQueue(deviceId, () =>
        adb.dumpWindowHierarchy(deviceId)
      )
      source = 'uncompressed'
      dumpMs = Date.now() - started
    }

    const parseStarted = Date.now()
    const snapshot = parseSnapshot(deviceId, xml, compressed)

    return render(deviceId, snapshot, source, args, {
      dumpMs,
      parseMs: Date.now() - parseStarted,
    })
  },
}

function render(
  deviceId: string,
  snapshot: any,
  source: string,
  args: any,
  cost: { dumpMs: number; parseMs: number }
) {
  const raw = args.raw === true
  const total = snapshot.flat.length
  const fields = Array.isArray(args.fields) ? args.fields : null

  const meta = {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    source,
    indexable: true,
    total,
    stale: snapshot.stale,
    expiresAt: snapshot.createdAt + SNAPSHOT_TTL_MS,
    dumpMs: cost.dumpMs,
    parseMs: cost.parseMs,
  }

  let diff: any = null
  if (typeof args.diffFrom === 'string' && args.diffFrom) {
    const result = diffSnapshot(args.diffFrom, snapshot)
    diff = {
      from: args.diffFrom,
      available: result.available,
      changed: result.changed,
      appeared: result.appeared.map((node: any) => projectNode(node, fields)),
      disappeared: result.disappeared.map((node: any) =>
        projectNode(node, fields)
      ),
    }
  }

  if (raw) {
    return jsonResult({
      ok: true,
      deviceId,
      ...meta,
      indexable: false,
      xml: snapshot.xml,
    })
  }

  const depth =
    typeof args.depth === 'number' && args.depth > 0 ? args.depth : 12
  const maxNodes =
    typeof args.maxNodes === 'number' && args.maxNodes > 0 ? args.maxNodes : 100
  const hasFilter = !!(args.text || args.id || args.desc || args.clickableOnly)

  if (hasFilter) {
    const matched = findMatches(snapshot.flat, {
      text: args.text,
      id: args.id,
      desc: args.desc,
      clickableOnly: !!args.clickableOnly,
      exact: false,
    })
    const cursor = Math.min(
      Math.max(Math.floor(Number(args.cursor) || 0), 0),
      matched.length
    )
    const page = matched.slice(cursor, cursor + maxNodes)

    return jsonResult({
      ok: true,
      deviceId,
      ...meta,
      matched: matched.length,
      returned: page.length,
      truncated: cursor + page.length < matched.length,
      cursor,
      nextCursor:
        cursor + page.length < matched.length ? cursor + page.length : null,
      diff,
      nodes: page.map((node: any) => projectNode(node, fields)),
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

  const tree = compactTree(snapshot.root, depth, maxNodes, fields)

  return jsonResult({
    ok: true,
    deviceId,
    ...meta,
    returned: tree.count,
    truncated: tree.truncated,
    diff,
    nodes: tree.nodes,
  })
}

export default [screencap, uiDump]
