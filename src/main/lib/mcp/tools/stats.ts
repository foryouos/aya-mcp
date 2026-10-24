import { getStats, resetStats } from '../lib/stats'
import { jsonResult } from '../lib/result'
import { McpTool } from './types'

const stats: McpTool = {
  name: 'aya_stats',
  description:
    '查看本次会话的工具调用指标：每个工具的次数/平均/p50/p95/最大耗时、失败码分布，以及 uiautomator dump 次数与缓存复用率。用于定位「哪一步慢」和验证优化是否生效（dump.count 越少、reuseRate 越高越好）。reset:true 清零后重新统计。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: '最多返回多少个工具（按总耗时降序），默认 15',
      },
      reset: {
        type: 'boolean',
        description: '先清零再返回（用于开始新一轮测量）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 15000,
  handler: async (args) => {
    if (args.reset === true) {
      resetStats()
      return jsonResult({ ok: true, deviceId: null, reset: true })
    }

    const limit = Math.min(
      Math.max(Math.floor(Number(args.limit) || 15), 1),
      100
    )
    const snapshot = getStats()

    return jsonResult({
      ok: true,
      ...snapshot,
      tools: snapshot.tools.slice(0, limit),
      hint: snapshot.totals.calls
        ? 'dump.avgMs 远高于其它工具时，优先用 aya_ui_dump 的 reuse/cursor 或 aya_webview_* 降低 dump 次数'
        : '还没有调用记录；先执行几次工具再看',
    })
  },
}

export default [stats]
