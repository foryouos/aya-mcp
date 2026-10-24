import { resolveDeviceId } from '../lib/device'
import {
  captureUi,
  performKey,
  performSwipe,
  performTap,
  performText,
  resolveSettle,
  sleep,
} from '../lib/action'
import { invalidateDump } from '../lib/dump'
import { dropSnapshot } from '../lib/snapshot'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const MAX_STEPS = 20

const stepSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['tap', 'tap_text', 'swipe', 'key', 'text', 'wait'],
      description: '动作类型',
    },
    x: { type: 'number', description: 'tap：X 坐标' },
    y: { type: 'number', description: 'tap：Y 坐标' },
    text: {
      type: 'string',
      description: 'tap/tap_text：按控件文本定位；action=text 时要输入的文本',
    },
    id: { type: 'string', description: 'tap：按 resource-id 定位' },
    desc: { type: 'string', description: 'tap：按 content-desc 定位' },
    index: { type: 'number', description: 'tap：同名控件取第几个，默认 0' },
    exact: {
      type: 'boolean',
      description: 'tap：是否精确匹配文本，默认 true',
    },
    nodeIndex: {
      type: 'number',
      description: 'tap：快照节点索引（需配 snapshotId，仅建议在同一步内使用）',
    },
    snapshotId: { type: 'string', description: 'tap：快照 id' },
    x1: { type: 'number', description: 'swipe：起点 X' },
    y1: { type: 'number', description: 'swipe：起点 Y' },
    x2: { type: 'number', description: 'swipe：终点 X' },
    y2: { type: 'number', description: 'swipe：终点 Y' },
    duration: { type: 'number', description: 'swipe：滑动时长，默认 300' },
    key: {
      type: ['string', 'number'],
      description: 'key：按键名称或 keycode',
    },
    ms: { type: 'number', description: 'wait：等待毫秒数（上限 10000）' },
    settle: {
      type: 'number',
      description: '本步结束后的等待毫秒数，默认 120',
    },
    resolve: {
      type: 'string',
      enum: ['auto', 'snapshot', 'dump'],
      description:
        "文本/id 定位时如何取界面：auto（默认，快照过期才 dump）、snapshot（复用当前快照，不 dump，最快但坐标可能过时）、dump（强制重新 dump）",
    },
    clear: {
      type: 'boolean',
      description: 'action=text 时是否先清空输入框，默认 true',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const batch: McpTool = {
  name: 'aya_batch',
  description:
    '一次调用串行执行最多 20 个动作，最后统一返回界面。用于「点击播放器 → 等 200ms → 点控制栏按钮」这类中间态只存在 1-3 秒的场景：模型无需在动作之间往返，彻底消除思考延迟。纯坐标/nodeIndex 步骤不产生 dump；text/id 定位默认按需 dump，也可用 resolve:snapshot 完全复用现有快照。失败即停并在 failedAt（0 基）指出位置，仍会返回当前界面便于纠正。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
      steps: {
        type: 'array',
        description: `动作列表（1-${MAX_STEPS} 个）`,
        items: stepSchema,
      },
      settle: {
        type: 'number',
        description: '每步默认等待毫秒数，默认 120',
      },
      ui: {
        type: 'string',
        enum: ['none', 'diff', 'full'],
        description:
          '结束后的界面返回粒度：diff（默认，只返回变化节点 + 可交互节点）、none（不返回，最省时间）、full（返回更多节点，上限由 uiMaxNodes 决定）',
      },
      withUi: {
        type: 'boolean',
        description: '结束后是否返回界面（旧参数，等价于 ui:diff/none）',
      },
      uiMaxNodes: {
        type: 'number',
        description: '回传的可交互节点上限，默认 diff 60 / full 120',
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const batchStarted = Date.now()
    const deviceId = await resolveDeviceId(args.deviceId)
    const steps = Array.isArray(args.steps) ? args.steps : []

    if (!steps.length) {
      throw new McpError('INVALID_ARGS', 'steps 不能为空')
    }
    if (steps.length > MAX_STEPS) {
      throw new McpError(
        'INVALID_ARGS',
        `一次最多 ${MAX_STEPS} 步，收到 ${steps.length} 步`
      )
    }

    // 从真实当前界面起步：不继承其它调用残留的 dump 缓存与快照
    invalidateDump(deviceId)
    dropSnapshot(deviceId)

    const defaultSettle = resolveSettle(args, 120)
    const results: any[] = []
    let failedAt: number | null = null
    let error: { code: string; message: string } | null = null

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] || {}
      const action = String(step.action || '').toLowerCase()
      const settle = resolveSettle(step, defaultSettle)
      const started = Date.now()

      try {
        switch (action) {
          case 'tap':
          case 'tap_text': {
            const { target } = await performTap(
              { ...step, deviceId },
              settle
            )
            results.push({
              index,
              action,
              ok: true,
              point: target.point,
              matchedCount: target.matchedCount,
              ms: Date.now() - started,
            })
            break
          }
          case 'swipe': {
            const duration =
              typeof step.duration === 'number' && step.duration > 0
                ? step.duration
                : 300
            await performSwipe(
              deviceId,
              {
                x1: step.x1,
                y1: step.y1,
                x2: step.x2,
                y2: step.y2,
              },
              duration,
              settle
            )
            results.push({
              index,
              action,
              ok: true,
              duration,
              ms: Date.now() - started,
            })
            break
          }
          case 'key': {
            const { code } = await performKey(deviceId, step.key, settle)
            results.push({
              index,
              action,
              ok: true,
              keycode: code,
              ms: Date.now() - started,
            })
            break
          }
          case 'text': {
            const typed = await performText(
              deviceId,
              String(step.text || ''),
              settle,
              { clear: step.clear !== false }
            )
            results.push({
              index,
              action,
              ok: true,
              text: step.text,
              cleared: typed.cleared,
              imeSwitched: typed.ime.switched,
              ms: Date.now() - started,
            })
            break
          }
          case 'wait': {
            const ms = Math.min(
              Math.max(Math.floor(Number(step.ms) || 0), 0),
              10000
            )
            await sleep(ms)
            results.push({ index, action, ok: true, ms })
            break
          }
          default:
            throw new McpError(
              'INVALID_ARGS',
              `第 ${index} 步 action 无效：${String(step.action)}`
            )
        }
      } catch (err) {
        failedAt = index
        error = {
          code: (err as any).code || 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        }
        break
      }
    }

    const uiMode =
      args.ui === 'none' || args.ui === 'diff' || args.ui === 'full'
        ? args.ui
        : args.withUi === false
          ? 'none'
          : 'diff'

    let ui: Awaited<ReturnType<typeof captureUi>> | null = null
    let uiError: string | null = null
    if (uiMode !== 'none') {
      try {
        ui = await captureUi(deviceId, {
          maxNodes:
            typeof args.uiMaxNodes === 'number'
              ? args.uiMaxNodes
              : uiMode === 'full'
                ? 120
                : 60,
        })
      } catch (err) {
        uiError = err instanceof Error ? err.message : String(err)
      }
    }

    const payload: any = {
      ok: failedAt === null,
      deviceId,
      executed: results.length,
      results,
      uiMode,
      ui,
      uiError,
      totalMs: Date.now() - batchStarted,
    }

    if (failedAt !== null) {
      payload.failedAt = failedAt
      payload.failedStep = steps[failedAt]
      payload.error = error
      payload.hint =
        'failedAt 为 0 基下标；失败步骤之前的动作已生效。可用 ui.nodes 重新定位后再次调用 aya_batch 从失败处继续'
    }

    return jsonResult(payload)
  },
}

export default [batch]
