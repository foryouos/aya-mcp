import {
  clearSerial,
  closeSerial,
  detectSerialBaudRate,
  getSerialStages,
  getStatus,
  listPorts,
  openSerial,
  queryLines,
  setSerialPaused,
  waitSerial,
  writeSerial,
} from '../../serial'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const SOURCES = ['all', 'bootloader', 'kernel', 'android', 'other']
const MAX_LINES = 2000

const status: McpTool = {
  name: 'aya_serial_status',
  description:
    '查看串口日志服务状态：可用串口列表、连接参数（波特率/8N1）、接收行数与字节数、是否暂停、以及完整会话日志文件路径。串口日志包含 bootloader/kernel/android 各阶段输出，量很大，读取日志请用 aya_serial_logs 并配合过滤条件。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async () => {
    const ports = await listPorts()
    const state = getStatus()
    return jsonResult({
      ok: true,
      ...state,
      ports,
      hint: state.open
        ? '串口已连接。日志量大时优先使用 keyword/source/fromSeq 过滤，或直接读取 logFiles 中的文件。'
        : '串口未连接，可用 aya_serial_open 打开（path 省略时自动选择唯一串口）。',
    })
  },
}

const logs: McpTool = {
  name: 'aya_serial_logs',
  description:
    '读取串口日志缓冲区，支持关键字/正则、来源（bootloader/kernel/android/other）与起始序号过滤，返回带时间与来源的行。默认返回最近 N 条（看设备当前状态）；传 fromSeq 则从该序号往后取（增量续读，用上次返回的 lastSeq）。缓冲区默认保留最近 20 万行；更早或完整的内容在 logFiles 文件中，可直接用文件工具读取。',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '关键字过滤（不区分大小写），如 panic、boot_completed',
      },
      regex: {
        type: 'boolean',
        description: 'keyword 是否按正则解析，默认 false',
      },
      source: {
        type: 'string',
        enum: SOURCES,
        description:
          '日志来源：all/bootloader/kernel/android/other，默认 all',
      },
      fromSeq: {
        type: 'number',
        description: '只返回 seq 大于该值的日志，用于增量读取',
      },
      lines: {
        type: 'number',
        description: `最多返回多少条，默认 200，上限 ${MAX_LINES}`,
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const state = getStatus()
    const source = String(args.source || 'all')
    if (!SOURCES.includes(source)) {
      throw new McpError(
        'INVALID_ARGS',
        `source 必须是 ${SOURCES.join('/')} 之一，收到：${source}`
      )
    }

    const limit = Math.min(
      Math.max(Math.floor(Number(args.lines) || 200), 1),
      MAX_LINES
    )
    const fromSeq = Number(args.fromSeq) || 0
    const keyword = String(args.keyword || '')
    if (args.regex && keyword) {
      try {
        new RegExp(keyword)
      } catch (err) {
        throw new McpError(
          'INVALID_ARGS',
          `正则表达式无效：${(err as Error).message}`
        )
      }
    }

    const result = queryLines({
      keyword,
      regex: !!args.regex,
      source: source as any,
      fromSeq,
      lines: limit,
      // 不带 fromSeq 时用户是在看“现在是什么情况”，取最近 N 条；
      // 带 fromSeq 时是在增量续读，仍从该位置往后取
      latest: !fromSeq,
    })

    if (!state.sessionId) {
      return jsonResult({
        ok: true,
        open: false,
        empty: true,
        entries: [],
        hint: '串口尚未连接过，先用 aya_serial_open 打开串口。',
      })
    }

    return jsonResult({
      ok: true,
      open: state.open,
      paused: state.paused,
      total: result.total,
      matched: result.matched,
      returned: result.returned,
      truncated: result.truncated,
      empty: result.returned === 0,
      lastSeq: result.lines.length
        ? result.lines[result.lines.length - 1].seq
        : result.status.seq,
      logFile: result.status.logFile,
      logFiles: result.status.logFiles,
      entries: result.lines.map((line) => ({
        seq: line.seq,
        time: new Date(line.time).toISOString(),
        source: line.source,
        text: line.text,
      })),
      hint:
        result.total === 0
          ? '缓冲区暂无日志；若串口已连接，请确认设备确实在输出。'
          : '需要更多历史日志时，读取 logFile 指向的文件；缓冲区已满后旧日志只保留在文件中。',
    })
  },
}

const wait: McpTool = {
  name: 'aya_serial_wait',
  description:
    '等待串口日志中出现指定关键字/正则，常用于等待 bootloader 完成、kernel 启动完成或 Android 开机广播（如 boot_completed）。只匹配调用之后新到达的日志，已经出现过的不算命中（要查历史用 aya_serial_logs 的 keyword）；应先调用本工具再触发设备动作。超时返回 matched=false。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '要等待的关键字或正则，如 "boot_completed"',
      },
      regex: {
        type: 'boolean',
        description: 'pattern 是否按正则解析，默认 false',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒），默认 15000，上限 300000',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 330000,
  handler: async (args) => {
    const pattern = String(args.pattern || '').trim()
    if (!pattern) {
      throw new McpError('INVALID_ARGS', 'pattern 不能为空')
    }
    const timeout = Math.min(
      Math.max(Number(args.timeout) || 15000, 1000),
      300000
    )
    const res = await waitSerial(pattern, {
      regex: !!args.regex,
      timeout,
    })
    return jsonResult({
      ok: true,
      matched: res.matched,
      waited: res.waited,
      line: res.line
        ? {
            seq: res.line.seq,
            time: new Date(res.line.time).toISOString(),
            source: res.line.source,
            text: res.line.text,
          }
        : null,
      hint: res.matched
        ? null
        : '超时未匹配到（只匹配调用之后新到达的日志）；可用 aya_serial_logs 的 keyword 查历史，或确认设备当前输出。',
    })
  },
}

const listPortsTool: McpTool = {
  name: 'aya_serial_list_ports',
  description:
    '列出主机上的串口设备（USB 转串口，如 COM3、/dev/ttyUSB0），用于在 aya_serial_open 之前确认可用的调试串口。注意与 adb 端口转发工具 aya_list_ports 无关。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async () => {
    const ports = await listPorts()
    return jsonResult({
      ok: true,
      total: ports.length,
      ports,
      hint: ports.length
        ? '打开串口用 aya_serial_open，path 可省略（仅一个串口时自动选中）。'
        : '未发现串口设备，请检查 USB 转串口驱动是否安装。',
    })
  },
}

const open: McpTool = {
  name: 'aya_serial_open',
  description:
    '打开主机串口（USB 转串口）接收设备启动/内核/Android 日志。默认 8 数据位、1 停止位、无校验、无流控。串口由主机侧提供，与 adb 设备无关；省略 path 时若只有一个串口会自动选中（可用 aya_serial_list_ports 查看）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '串口路径，如 Windows 的 COM3、Linux 的 /dev/ttyUSB0',
      },
      baudRate: {
        type: ['number', 'string'],
        enum: [115200, 460800, 921600, 1500000, 3000000, 'auto'],
        description:
          '波特率，默认 115200；传 "auto" 会以 115200 打开后依次尝试 1500000/921600/115200 并按可读字符比例打分，返回 detectedBaudRate 与 confidence',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    let path = String(args.path || '').trim()
    const autoBaud = args.baudRate === 'auto'
    const baudRate = autoBaud ? 115200 : Number(args.baudRate) || 115200
    if (baudRate < 300 || baudRate > 4000000) {
      throw new McpError('INVALID_ARGS', `波特率不合法：${baudRate}`)
    }

    if (!path) {
      const ports = await listPorts()
      if (ports.length === 1) {
        path = ports[0].path
      } else if (!ports.length) {
        throw new McpError(
          'NOT_FOUND',
          '未发现串口设备，请检查 USB 转串口驱动是否安装'
        )
      } else {
        throw new McpError(
          'INVALID_ARGS',
          `存在多个串口，请指定 path：${ports.map((p) => p.path).join(', ')}`
        )
      }
    }

    const state = await openSerial(path, baudRate)

    if (!autoBaud) {
      return jsonResult({
        ok: true,
        ...state,
        hint: '已开始接收并落盘。用 aya_serial_logs 读取，完整日志见 logFiles。',
      })
    }

    // 自动波特率：先以 115200 打开，再逐个采样打分
    const detection = await detectSerialBaudRate()

    return jsonResult({
      ok: true,
      ...getStatus(),
      detectedBaudRate: detection.rate,
      confidence: detection.confidence,
      score: Math.round(detection.score),
      hint: detection.detected
        ? `自动识别到 ${detection.rate}（置信度 ${detection.confidence}），已切换并继续接收。日志若仍乱码，可关闭后用 aya_serial_open 指定固定波特率重试。`
        : '未能自动识别波特率（设备可能没有输出）。请确认板子在上电/重启，或指定固定 baudRate 重试。',
    })
  },
}

const close: McpTool = {
  name: 'aya_serial_close',
  description: '关闭串口。已接收的日志仍在缓冲区与日志文件中，不会丢失。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async () => {
    const state = await closeSerial()
    return jsonResult({ ok: true, ...state })
  },
}

const write: McpTool = {
  name: 'aya_serial_write',
  description:
    '向串口写入数据（如向 bootloader 发送 reboot、向串口终端发送命令）。默认追加 \\r\\n。写操作需要开启“允许写操作”。',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: '要发送的文本，最长 4096 字符',
      },
      newline: {
        type: 'boolean',
        description: '是否追加 \\r\\n，默认 true',
      },
      waitForEcho: {
        type: 'string',
        description:
          '写入后等待该关键字/正则出现在串口回显中（如提示符或命令回显），省略则不等待',
      },
      regex: {
        type: 'boolean',
        description: 'waitForEcho 是否按正则解析，默认 false',
      },
      timeout: {
        type: 'number',
        description: 'waitForEcho 的超时毫秒数，默认 2000',
      },
    },
    required: ['data'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const data = String(args.data ?? '')
    if (!data) {
      throw new McpError('INVALID_ARGS', 'data 不能为空')
    }
    const sentBytes = await writeSerial(data, args.newline !== false)

    const payload: any = { ok: true, sent: data, sentBytes }

    const echo = String(args.waitForEcho || '').trim()
    if (echo) {
      const res = await waitSerial(echo, {
        regex: !!args.regex,
        timeout: Number(args.timeout) || 2000,
      })
      payload.echo = {
        matched: res.matched,
        waitedMs: res.waited,
        line: res.line
          ? { seq: res.line.seq, source: res.line.source, text: res.line.text }
          : null,
      }
    }

    return jsonResult(payload)
  },
}

const clear: McpTool = {
  name: 'aya_serial_clear',
  description:
    '清空串口日志缓冲区并新建会话日志文件（串口保持连接）。配合 aya_serial_logs 使用：先清空，复现问题，再只读取本次产生的日志。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async () => {
    const state = clearSerial()
    return jsonResult({
      ok: true,
      ...state,
      hint: '缓冲区已清空，新日志写入新的 logFile。',
    })
  },
}

const pause: McpTool = {
  name: 'aya_serial_pause',
  description:
    '暂停串口日志推送（设备仍在接收并落盘，只是不再向前端/MCP 推送新行）。配合 aya_serial_resume 恢复，无需关闭重开串口。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async () => {
    const state = setSerialPaused(true)
    return jsonResult({ ok: true, ...state })
  },
}

const resume: McpTool = {
  name: 'aya_serial_resume',
  description:
    '恢复串口日志推送（先前的 aya_serial_pause）。暂停期间产生的日志仍可从缓冲区读到。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async () => {
    const state = setSerialPaused(false)
    return jsonResult({ ok: true, ...state })
  },
}

const stages: McpTool = {
  name: 'aya_serial_stages',
  description:
    '按 bootloader/kernel/android/other 返回串口日志的阶段切分（startSeq/endSeq/durationMs/行数），用于快速定位「卡在哪个阶段」，避免拉全量日志自行切分。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async () => {
    const state = getStatus()
    const list = getSerialStages()

    return jsonResult({
      ok: true,
      open: state.open,
      paused: state.paused,
      seq: state.seq,
      stages: list,
      hint: list.length
        ? '用 aya_serial_logs 的 fromSeq/toSeq 精确读取某个阶段；阶段边界由日志特征行推断，可能在重启时回退到 bootloader。'
        : '缓冲区暂无日志，先用 aya_serial_open 打开串口并让设备输出。',
    })
  },
}

export default [
  status,
  logs,
  wait,
  stages,
  listPortsTool,
  open,
  close,
  pause,
  resume,
  write,
  clear,
]
