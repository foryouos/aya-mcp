import * as adb from '../../adb'
import { injectGesture, IGestureStep } from '../../adb/server'
import { resolveDeviceId } from '../lib/device'
import {
  afterInput,
  captureUi,
  performKey,
  performSwipe,
  performText,
  resolveSettle,
  resolveWithUi,
  verifyFocusedText,
} from '../lib/action'
import { invalidateDump, withDeviceQueue } from '../lib/dump'
import { parseSnapshot } from '../lib/snapshot'
import { assertShellOk } from '../lib/shellCheck'
import { resolveTarget } from '../lib/target'
import { brief, compactTree } from '../lib/ui'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const settleProperty = {
  type: 'number',
  description: '操作后等待界面稳定的毫秒数，默认 300',
}

const withUiProperty = {
  type: ['boolean', 'string'],
  description:
    '操作后是否立即抓取新界面。默认 "auto"：aya_tap 抓取（便于看到瞬时控件），滑动/按键/输入不抓取以省掉 0.3-1s；传 true 强制抓取，false 强制不抓取',
}

const uiMaxNodesProperty = {
  type: 'number',
  description: 'withUi 回传的可交互节点上限，默认 60',
}

async function capture(deviceId: string, args: any) {
  try {
    return {
      ui: await captureUi(deviceId, { maxNodes: args.uiMaxNodes }),
      uiError: null as string | null,
    }
  } catch (err) {
    return {
      ui: null,
      uiError: err instanceof Error ? err.message : String(err),
    }
  }
}

const swipe: McpTool = {
  name: 'aya_swipe',
  description:
    '在屏幕上滑动，从 (x1,y1) 滑到 (x2,y2)。duration 为滑动时长（毫秒），默认 300。默认走常驻 UiAutomation 注入，失败自动降级 input swipe。连续滑动时可开 withUi 观察结果。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      x1: { type: 'number', description: '起点 X' },
      y1: { type: 'number', description: '起点 Y' },
      x2: { type: 'number', description: '终点 X' },
      y2: { type: 'number', description: '终点 Y' },
      duration: { type: 'number', description: '滑动时长（毫秒），默认 300' },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['x1', 'y1', 'x2', 'y2'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const duration =
      typeof args.duration === 'number' && args.duration > 0
        ? args.duration
        : 300
    const { settledMs, via } = await performSwipe(
      deviceId,
      { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 },
      duration,
      resolveSettle(args, 300)
    )

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

    return jsonResult({ ok: true, deviceId, duration, via, settledMs, ...extra })
  },
}

const longPress: McpTool = {
  name: 'aya_long_press',
  description:
    '长按屏幕上的坐标或控件（按住 duration 毫秒后抬起）。视频控制条、自定义长按菜单、拖拽起点都只能靠它触发。定位方式与 aya_tap 相同：{x,y}、{nodeIndex,snapshotId} 或 {text,id,desc}。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      x: { type: 'number', description: '长按位置 X（与 y 一起使用）' },
      y: { type: 'number', description: '长按位置 Y' },
      nodeIndex: {
        type: 'number',
        description: 'aya_ui_dump 返回的节点 i，必须配合 snapshotId',
      },
      snapshotId: { type: 'string', description: 'aya_ui_dump 返回的 snapshotId' },
      text: { type: 'string', description: '按控件文本定位' },
      id: { type: 'string', description: '按 resource-id 定位（支持短 id）' },
      desc: { type: 'string', description: '按 content-desc 定位' },
      index: {
        type: 'number',
        description: '匹配到多个控件时选择第几个，默认 0',
      },
      exact: { type: 'boolean', description: '是否精确匹配，默认 true' },
      includeInvisible: {
        type: 'boolean',
        description: '是否允许匹配屏幕外节点，默认 false',
      },
      duration: {
        type: 'number',
        description: '按住时长（毫秒），默认 600，范围 300-10000',
      },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const duration = Math.min(
      Math.max(Math.floor(Number(args.duration) || 600), 300),
      10000
    )
    const target = await resolveTarget({ ...args, deviceId })
    const started = Date.now()

    // Android 上 `input swipe x y x y <ms>` 就是长按：原地按下并保持 ms 后抬起
    const output = await withDeviceQueue(target.deviceId, () =>
      adb.inputSwipe(
        target.deviceId,
        target.point[0],
        target.point[1],
        target.point[0],
        target.point[1],
        duration
      )
    )
    assertShellOk(output, 'aya_long_press')
    const settledMs = await afterInput(
      target.deviceId,
      resolveSettle(args, 300)
    )

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

    return jsonResult({
      ok: true,
      deviceId: target.deviceId,
      point: target.point,
      duration,
      matchedCount: target.matchedCount,
      node: target.node ? brief(target.node) : null,
      ...(target.warning ? { warning: target.warning } : {}),
      settledMs,
      totalMs: Date.now() - started,
      ...extra,
    })
  },
}

export function normalizeSteps(input: unknown): IGestureStep[] {
  if (!Array.isArray(input) || !input.length) {
    throw new McpError(
      'INVALID_ARGS',
      'steps 不能为空，至少要有 down 和 up 两步'
    )
  }

  const steps: IGestureStep[] = input.map((raw, index) => {
    const step = (raw || {}) as Record<string, unknown>
    const action = String(step.action || '').toLowerCase()
    if (!['down', 'move', 'up', 'cancel'].includes(action)) {
      throw new McpError(
        'INVALID_ARGS',
        `steps[${index}].action 必须是 down/move/up/cancel，收到 ${action || '(空)'}`
      )
    }
    const ret: IGestureStep = {
      action: action as IGestureStep['action'],
    }
    if (typeof step.x === 'number') {
      ret.x = step.x
    }
    if (typeof step.y === 'number') {
      ret.y = step.y
    }
    if (typeof step.delayMs === 'number' && step.delayMs > 0) {
      ret.delayMs = Math.min(step.delayMs, 10000)
    }

    return ret
  })

  if (steps[0].action !== 'down') {
    throw new McpError('INVALID_ARGS', 'steps 第一步必须是 down')
  }
  if (steps[0].x === undefined || steps[0].y === undefined) {
    throw new McpError('INVALID_ARGS', 'steps 第一步（down）必须给出 x 和 y')
  }
  const last = steps[steps.length - 1]
  // 不收尾会把手势的按下状态留在系统里，后续 tap 全部错乱
  if (last.action !== 'up' && last.action !== 'cancel') {
    throw new McpError(
      'INVALID_ARGS',
      'steps 最后一步必须是 up（或 cancel），否则触摸会一直保持按下状态'
    )
  }

  return steps
}

const gesture: McpTool = {
  name: 'aya_gesture',
  description:
    '注入一段连续触摸事件流，一段事件流内可包含多组 down/up：down → (delayMs) → move... → up → (delayMs) → down → ... → up。用于 aya_swipe 表达不了的手势：按住不动一段时间再拖（长按拖拽）、多段折线拖动、拖到中途停住观察界面（captureAt），以及「轻点唤醒 + 立即操作」——控制栏 1-3 秒自动隐藏时，同一段手势内先点视频区唤醒再点/拖目标控件，避免跨调用错过中间态。示例：先轻点唤醒再拖进度条 = [{action:"down",x:700,y:700},{action:"up",x:700,y:700,delayMs:60},{action:"down",x:300,y:972,delayMs:300},{action:"move",x:710,y:972,delayMs:70},{action:"up",x:710,y:972,delayMs:110}]。走服务端常驻 UiAutomation，不可用时抛错，请降级为 aya_swipe / aya_long_press。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      steps: {
        type: 'array',
        description:
          '手势步骤，首步必须 down(带 x,y)，末步必须 up。每步的 delayMs 在注入该事件之前等待。可包含多组 down/up（如「轻点唤醒 + 拖动」），每组独立成对出现',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['down', 'move', 'up', 'cancel'],
            },
            x: { type: 'number' },
            y: { type: 'number' },
            delayMs: {
              type: 'number',
              description:
                '本步注入前等待的毫秒数。放在 down 之后就是「按住时长」',
            },
          },
          required: ['action'],
        },
      },
      captureAt: {
        type: 'number',
        description:
          '在第 N 步（从 0 开始）执行完之后抓一次界面树，0 表示按下后立刻抓。用于观察按住过程中的界面，返回的 nodes 可直接用 nodeIndex 点击',
      },
      depth: { type: 'number', description: 'capture 返回树的最大深度，默认 10' },
      maxNodes: {
        type: 'number',
        description: 'capture 返回树的最大节点数，默认 80',
      },
      visibleOnly: {
        type: 'boolean',
        description: 'capture 返回树时是否只保留可见节点，默认 true',
      },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['steps'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const steps = normalizeSteps(args.steps)
    const captureAt = Number.isInteger(args.captureAt)
      ? Number(args.captureAt)
      : -1
    const started = Date.now()

    let injected: { xml?: string; totalMs?: number }
    try {
      injected = await withDeviceQueue(deviceId, () =>
        injectGesture(deviceId, {
          steps,
          captureAt,
          maxNodes: 1500,
          maxDepth: 60,
        })
      )
    } catch (err) {
      throw new McpError(
        'INTERNAL',
        `服务端手势注入不可用（${
          err instanceof Error ? err.message : String(err)
        }），改用 aya_swipe / aya_long_press`,
        { deviceId, steps }
      )
    }

    const gestureMs = injected.totalMs || Date.now() - started
    // 手势改变了界面，discard 掉旧的 xml 缓存，避免后续定位读到手势前的树
    invalidateDump(deviceId)

    const extra: Record<string, unknown> = {}
    if (injected.xml && injected.xml.indexOf('<hierarchy') >= 0) {
      const snapshot = parseSnapshot(deviceId, injected.xml, true)
      const tree = snapshot.root
        ? compactTree(
            snapshot.root,
            Math.min(Math.max(Math.floor(Number(args.depth) || 10), 1), 30),
            Math.min(Math.max(Math.floor(Number(args.maxNodes) || 80), 1), 400),
            null,
            { visibleOnly: args.visibleOnly !== false }
          )
        : { nodes: [], count: 0, hidden: 0, truncated: false }
      Object.assign(extra, {
        capturedAt: captureAt,
        capturedDuringGesture: captureAt >= 0 && captureAt < steps.length - 1,
        snapshotId: snapshot.id,
        fingerprint: snapshot.fingerprint,
        total: snapshot.flat.length,
        returned: tree.count,
        hidden: tree.hidden,
        nodes: tree.nodes,
      })
    }

    const settledMs = await afterInput(deviceId, resolveSettle(args, 300))
    if (resolveWithUi(args.withUi, false)) {
      Object.assign(extra, await capture(deviceId, args))
    }

    return jsonResult({
      ok: true,
      deviceId,
      steps: steps.length,
      gestureMs,
      settledMs,
      totalMs: Date.now() - started,
      ...extra,
    })
  },
}

const key: McpTool = {
  name: 'aya_key',
  description:
    '发送按键事件（默认走常驻 UiAutomation 注入，失败自动降级 input keyevent）。支持名称（back/home/enter/recent/volume_up/volume_down/power/menu/delete/tab/escape/search/dpad_*）或 Android keycode 数字。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      key: {
        type: ['string', 'number'],
        description: '按键名称或 keycode，例如 "back" 或 4',
      },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['key'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const { code, settledMs, via } = await performKey(
      deviceId,
      args.key,
      resolveSettle(args, 300)
    )

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

    return jsonResult({
      ok: true,
      deviceId,
      key: args.key,
      keycode: code,
      via,
      settledMs,
      ...extra,
    })
  },
}

const text: McpTool = {
  name: 'aya_text',
  description:
    '向当前焦点输入框写入文本。默认走系统 ACTION_SET_TEXT：一次调用完成整体替换，不经过输入法，中文/emoji 可直接写入，也不会被 Gboard/搜狗等联想改写。只有当输入框不支持直接写入时才降级为 input text（此时仅支持可打印 ASCII，并自动临时切换输入法再恢复）。clear:false 表示追加到原内容之后。传入 verify:true 会在输入后回读界面确认实际内容。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      text: {
        type: 'string',
        description: '要输入的文本；优先通道支持中文与 emoji，降级通道仅限可打印 ASCII',
      },
      clear: {
        type: 'boolean',
        description: '输入前是否清空输入框，默认 true',
      },
      ime: {
        type: 'string',
        enum: ['auto', 'keep'],
        description:
          'auto（默认）：当前是 Gboard/搜狗等会改写文本的输入法时，临时切到系统输入法并在输入后恢复；keep：不动输入法',
      },
      verify: {
        type: 'boolean',
        description: '输入后抓取界面回读焦点输入框内容，默认 false（会多花约 0.3-1s）',
      },
      settle: settleProperty,
      withUi: withUiProperty,
      uiMaxNodes: uiMaxNodesProperty,
    },
    required: ['text'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const value = String(args.text)
    const result = await performText(deviceId, value, resolveSettle(args, 200), {
      clear: args.clear !== false,
      ime: args.ime === 'keep' ? 'keep' : 'auto',
    })

    let verify: any = null
    if (args.verify === true) {
      // 追加模式下输入框最终内容是「原文本 + 新文本」，回读要按最终内容比对
      const expected = String(result.expectedText ?? value)
      verify = await verifyFocusedText(deviceId, expected).catch((err) => ({
        matched: false,
        expected,
        error: err instanceof Error ? err.message : String(err),
      }))
    }

    const extra = resolveWithUi(args.withUi, false)
      ? await capture(deviceId, args)
      : {}

    return jsonResult({
      ok: true,
      deviceId,
      text: value,
      via: result.via,
      settledMs: result.settledMs,
      cleared: result.cleared,
      previousText: result.previousText,
      ime: result.ime,
      verify,
      ...extra,
    })
  },
}

export default [swipe, longPress, gesture, key, text]
