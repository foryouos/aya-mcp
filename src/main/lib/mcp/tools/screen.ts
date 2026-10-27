import fs from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import * as adb from '../../adb'
import * as base from '../../adb/base'
import * as adbFile from '../../adb/file'
import { uiScreenshot } from '../../adb/server'
import { blockShot, isShotBlocked } from '../lib/inject'
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
    '截取设备当前屏幕并直接返回图片。默认在设备端完成缩放与 JPEG 编码（宽 900、quality 72），只回传几十~几百 KB，比整张 PNG 过 adb 小 5-10 倍、也更快；设备端截图不可用时自动降级为 adb screencap（返回里的 source 会标明 uiAutomation 还是 adb）。只在 uiautomator 读不到内容（视频、游戏、Canvas、相机）时才需要它。',
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
    const maxWidth = typeof args.maxWidth === 'number' ? args.maxWidth : 900
    const asPng = args.format === 'png'
    const quality = Math.min(
      Math.max(Math.floor(Number(args.quality) || 72), 1),
      100
    )

    const crop = args.crop
    const hasCrop =
      !!crop &&
      [crop.x, crop.y, crop.width, crop.height].every(
        (value) => typeof value === 'number' && Number.isFinite(value)
      )

    // 设备端截图优先：在 Shell 进程里 takeScreenshot → 缩放 → JPEG 压缩，
    // 只回传几百 KB，省掉整张 PNG 过 adb 的带宽（1080p 约 1.5MB）
    let via: 'uiAutomation' | 'adb' = 'adb'
    let shotMs = 0
    let raw: Buffer | null = null
    // 设备端截图可能已在设备上缩放，meta 里的宽高必须是原始设备像素
    let deviceSize: { width: number; height: number } | null = null
    // 设备端回传的图片尺寸（已按 maxWidth 缩放）
    let shotSize: { width: number; height: number } | null = null
    if (typeof args.displayId !== 'number' && !isShotBlocked(deviceId)) {
      try {
        const shot = await uiScreenshot(deviceId, {
          // crop 需要原始像素做裁剪，所以设备端不缩放，只做高质量压缩
          maxWidth: hasCrop ? 0 : maxWidth,
          quality: hasCrop ? Math.max(quality, 95) : quality,
          format: asPng ? 'png' : 'jpeg',
        })
        raw = Buffer.from(shot.data, 'base64')
        via = 'uiAutomation'
        shotMs = shot.totalMs || 0
        if (shot.sourceWidth && shot.sourceHeight) {
          deviceSize = { width: shot.sourceWidth, height: shot.sourceHeight }
        }
        if (shot.width && shot.height) {
          shotSize = { width: shot.width, height: shot.height }
        }
      } catch {
        blockShot(deviceId)
      }
    }
    if (!raw) {
      raw = await screencapBuffer(deviceId, args.displayId)
    }

    let buffer: Buffer
    let imageWidth = 0
    let imageHeight = 0
    let cropped: any = null
    let sourceWidth = 0

    // 设备端已经按目标宽度缩放并压成 JPEG 时，主机直接透传字节：
    // 省掉一次「解码 + 重编码」（1080p JPEG 重编码约 20-30ms）。
    // 需要 png 或需要裁剪时仍走主机侧处理。
    if (via === 'uiAutomation' && !hasCrop && !asPng && shotSize) {
      buffer = raw
      imageWidth = shotSize.width
      imageHeight = shotSize.height
      sourceWidth = deviceSize?.width || imageWidth
    } else {
      const image = nativeImage.createFromBuffer(raw)
      const size = image.getSize()
      let output = image

      if (hasCrop && crop) {
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
      sourceWidth = cropped ? cropped.width : deviceSize?.width || size.width
      if (maxWidth > 0 && output.getSize().width > maxWidth) {
        output = output.resize({ width: Math.round(maxWidth), quality: 'good' })
      }
      buffer = asPng ? output.toPNG() : output.toJPEG(quality)
      imageWidth = output.getSize().width
      imageHeight = output.getSize().height
      if (!deviceSize) {
        deviceSize = { width: size.width, height: size.height }
      }
    }
    const scale = imageWidth / sourceWidth

    const meta = {
      ok: true,
      deviceId,
      width: deviceSize?.width || imageWidth,
      height: deviceSize?.height || imageHeight,
      imageWidth,
      imageHeight,
      format: asPng ? 'png' : 'jpeg',
      quality: asPng ? null : quality,
      bytes: buffer.length,
      cropped,
      scale,
      source: via,
      shotMs,
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
    '获取当前界面的 UI 层级树（紧凑 JSON，每个节点含 bounds 与 center 坐标，bounds 已与父容器求交，只保留可见区域）。可用 text/id/desc/clickableOnly/visibleOnly 过滤，用 depth/maxNodes 限制体积，用 fields 只保留需要的字段，用 cursor 分页。visibleOnly:true 会剔除屏幕外与被滚动容器裁掉的节点（返回里 invisibleTotal 是它们的总数），长列表场景强烈建议开启。返回的 snapshotId 与节点 i 可用于 aya_tap 的 nodeIndex 精确定位。reuse:true 时不重新 dump、直接复用当前快照（配合 cursor 翻页可反复读取，几乎零耗时）。点击/滑动/按键/输入后快照会被标记过期（对应 nodeIndex 会要求重新 dump）。',
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
      visibleOnly: {
        type: 'boolean',
        description:
          '仅返回当前真正可见的节点（坐标为与父容器求交后的可见区域）。长列表/横向滚动容器里大量屏幕外节点会撑大返回体且坐标点不到，建议开启；默认 false',
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
      deviceCrop: {
        type: 'object',
        description:
          '实验性：把节点裁剪下推到设备端，减少设备端生成、传输与主机解析量。注意返回的树是稀疏的（按 i 编号仍与全树一致），不能直接用于后续按索引定位，定位请另调一次完整 dump',
        properties: {
          maxNodes: {
            type: 'number',
            description: '设备端最多生成的节点数，默认 100',
          },
          maxDepth: {
            type: 'number',
            description: '设备端最大深度，默认 12',
          },
        },
        additionalProperties: false,
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
    // 显式传入 deviceCrop 时才把裁剪下推到设备端；默认路径完全不变
    const cropArg = args.deviceCrop
    const deviceCrop =
      cropArg && typeof cropArg === 'object'
        ? {
            maxNodes:
              typeof cropArg.maxNodes === 'number' && cropArg.maxNodes > 0
                ? Math.floor(cropArg.maxNodes)
                : 100,
            maxDepth:
              typeof cropArg.maxDepth === 'number' && cropArg.maxDepth > 0
                ? Math.floor(cropArg.maxDepth)
                : 12,
          }
        : null
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
      const dump = await dumpFast(deviceId, deviceCrop || {})
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
    // 设备端裁剪出来的树是稀疏的，不能覆盖内部用于定位的完整快照
    const snapshot = parseSnapshot(deviceId, xml, compressed, {
      transient: !!deviceCrop,
    })

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
  const visibleOnly = args.visibleOnly === true
  const fields = Array.isArray(args.fields) ? args.fields : null
  const invisibleTotal = snapshot.flat.filter((node: any) => !node.visible).length

  const meta = {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    source,
    indexable: true,
    total,
    // 屏幕外/被容器裁掉的节点数：这些节点耗体积但点不到，可用 visibleOnly 过滤
    invisibleTotal,
    windows: snapshot.roots ? snapshot.roots.length : 1,
    stale: snapshot.stale,
    expiresAt: snapshot.createdAt + SNAPSHOT_TTL_MS,
    dumpMs: cost.dumpMs,
    parseMs: cost.parseMs,
    // 设备端裁剪时说明这棵树是稀疏的，不能直接用于后续按索引定位
    deviceCrop: args.deviceCrop
      ? {
          maxNodes:
            typeof args.deviceCrop.maxNodes === 'number'
              ? args.deviceCrop.maxNodes
              : 100,
          maxDepth:
            typeof args.deviceCrop.maxDepth === 'number'
              ? args.deviceCrop.maxDepth
              : 12,
          sparse: true,
        }
      : undefined,
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
      visibleOnly,
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

  const tree = compactTree(snapshot.root, depth, maxNodes, fields, {
    visibleOnly,
  })

  return jsonResult({
    ok: true,
    deviceId,
    ...meta,
    returned: tree.count,
    hidden: tree.hidden,
    truncated: tree.truncated,
    diff,
    nodes: tree.nodes,
  })
}

export default [screencap, uiDump]
