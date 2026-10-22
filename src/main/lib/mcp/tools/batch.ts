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
  },
  required: ['action'],
  additionalProperties: false,
}

const batch: McpTool = {
  name: 'aya_batch',
  description:
    '一次调用串行执行最多 20 个动作，最后统一返回界面。用于「点击播放器 → 等 200ms → 点控制栏按钮」这类中间态只存在 1-3 秒的场景：模型无需在动作之间往返，彻底消除思考延迟。步骤可用 text 定位（服务端每步自动 dump），失败即停并在 failedAt 指出位置，仍会返回当前界面便于纠正。',
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
      withUi: {
        type: 'boolean',
        description: '结束后是否返回界面（默认 true）',
      },
      uiMaxNodes: {
        type: 'number',
        description: '回传的可交互节点上限，默认 60',
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
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
            await performText(deviceId, String(step.text || ''), settle)
            results.push({
              index,
              action,
              ok: true,
              text: step.text,
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

    let ui: Awaited<ReturnType<typeof captureUi>> | null = null
    let uiError: string | null = null
    if (args.withUi !== false) {
      try {
        ui = await captureUi(deviceId, { maxNodes: args.uiMaxNodes })
      } catch (err) {
        uiError = err instanceof Error ? err.message : String(err)
      }
    }

    const payload: any = {
      ok: failedAt === null,
      deviceId,
      executed: results.length,
      results,
      ui,
      uiError,
    }

    if (failedAt !== null) {
      payload.failedAt = failedAt
      payload.error = error
      payload.hint =
        '失败步骤之前的动作已生效；用返回的 ui.nodes 重新定位后再次调用 aya_batch 从失败处继续'
    }

    return jsonResult(payload)
  },
}

export default [batch]
