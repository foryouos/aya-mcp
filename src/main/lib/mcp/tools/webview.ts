import * as base from '../../adb/base'
import { getTopPackage } from '../../adb/package'
import { fetchWebviews } from '../../adb/webview'
import { connectCdp, normalizeJsResult, pickPage } from '../lib/cdp'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

const packageProperty = {
  type: 'string',
  description: '目标应用包名；省略时使用前台应用',
}

const urlMatchProperty = {
  type: 'string',
  description: '页面 URL 子串，多个 WebView 时用它指定目标页面',
}

async function resolvePid(deviceId: string, packageName: string) {
  const output = await base.shell(deviceId, `pidof ${packageName}`)
  const pid = Number(String(output).trim().split(/\s+/)[0])

  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

async function resolveContext(args: any, deviceId: string) {
  let packageName = String(args.package || '').trim()
  let pid = Number(args.pid) || 0

  if (!pid) {
    if (!packageName) {
      const foreground = await getTopPackage(deviceId).catch(() => null)
      if (!foreground || !foreground.name) {
        throw new McpError(
          'DEVICE_OFFLINE',
          '无法确定前台应用，请显式传 package 或 pid'
        )
      }
      packageName = foreground.name
    }

    pid = await resolvePid(deviceId, packageName)
    if (!pid) {
      throw new McpError(
        'NOT_FOUND',
        `${packageName} 当前没有运行中的进程，无法枚举 WebView`
      )
    }
  }

  const webviews = await fetchWebviews(deviceId, pid)
  const page = pickPage(webviews, String(args.url || '').trim() || undefined)

  return { packageName, pid, webviews, page }
}

// 建立一条 CDP 连接，用完即关；connection 本身只有几十毫秒开销
async function openSession(args: any) {
  const deviceId = await resolveDeviceId(args.deviceId)
  const context = await resolveContext(args, deviceId)
  const target = String(args.webSocketDebuggerUrl || '').trim()
  const wsUrl = target || context.page?.webSocketDebuggerUrl

  if (!wsUrl) {
    throw new McpError(
      'NOT_FOUND',
      '未找到可调试的 WebView：应用需调用 WebView.setWebContentsDebuggingEnabled(true)，或页面尚未加载'
    )
  }

  const session = await connectCdp(
    wsUrl,
    Math.min(Math.max(Number(args.connectTimeout) || 8000, 1000), 20000)
  )

  return {
    deviceId,
    session,
    page: context.page
      ? { title: context.page.title, url: context.page.url }
      : null,
    pid: context.pid,
    package: context.packageName || null,
  }
}

const listWebviews: McpTool = {
  name: 'aya_list_webviews',
  description:
    '列出应用内可调试的 WebView 页面（标题、URL、devtoolsFrontendUrl、webSocketDebuggerUrl）。H5 页面出问题时先用它把页面 URL 和调试地址拿出来（在 Chrome 打开 devtoolsFrontendUrl 即可远程调试）。默认取前台应用。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: {
        type: 'number',
        description: '直接指定进程 pid（优先于 package）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const context = await resolveContext(args, deviceId)

    return jsonResult({
      ok: true,
      deviceId,
      package: context.packageName || null,
      pid: context.pid,
      total: context.webviews.length,
      webviews: context.webviews.map((item) => ({
        title: item.title,
        url: item.url,
        devtoolsFrontendUrl: item.devtoolsFrontendUrl,
        webSocketDebuggerUrl: item.webSocketDebuggerUrl,
        faviconUrl: item.faviconUrl || null,
      })),
      hint: context.webviews.length
        ? '读取/操作 H5 内容请直接用 aya_webview_snapshot / aya_webview_eval，比截屏 + 图像识别快得多；需要人工看时在 Chrome 打开 devtoolsFrontendUrl'
        : '未发现 WebView：应用可能未启用 WebView 调试，需在代码里调用 WebView.setWebContentsDebuggingEnabled(true)',
    })
  },
}

const evalJs: McpTool = {
  name: 'aya_webview_eval',
  description:
    '在 WebView 页面里执行 JavaScript 并返回结果（Runtime.evaluate，按值返回）。比截图 + 视觉识别快 1-2 个数量级：读页面状态、取 localStorage、点元素（element.click()）、填表单（value + dispatchEvent）都可用。可传 awaitPromise 等待 Promise 结果。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: {
        type: 'string',
        description: '直接指定调试地址（可来自 aya_list_webviews）',
      },
      expression: {
        type: 'string',
        description: '要执行的 JS 表达式，支持 return/多语句（会包成 async IIFE）',
      },
      awaitPromise: {
        type: 'boolean',
        description: '表达式返回 Promise 时是否等待其 resolve，默认 true',
      },
      timeout: { type: 'number', description: '命令超时毫秒数，默认 15000' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const expression = String(args.expression || '')
    if (!expression.trim()) {
      throw new McpError('INVALID_ARGS', 'expression 不能为空')
    }

    const context = await openSession(args)
    try {
      const result = await context.session.send(
        'Runtime.evaluate',
        {
          expression: `(async () => { ${expression} })()`,
          awaitPromise: args.awaitPromise !== false,
          returnByValue: true,
          userGesture: true,
        },
        Math.min(Math.max(Number(args.timeout) || 15000, 1000), 60000)
      )
      const normalized = normalizeJsResult(result)

      if (normalized.exception) {
        throw new McpError('INTERNAL', `JS 执行异常：${normalized.exception}`)
      }

      return jsonResult({
        ok: true,
        deviceId: context.deviceId,
        page: context.page,
        value: normalized.value === undefined ? null : normalized.value,
        description:
          normalized.value === undefined ? normalized.description : undefined,
      })
    } finally {
      context.session.close()
    }
  },
}

const consoleLogs: McpTool = {
  name: 'aya_webview_console',
  description:
    '收集 WebView 页面在指定时间窗内的 console 输出、未捕获异常与 JS 运行时错误（Runtime.consoleAPICalled / exceptionThrown / Log.entryAdded）。H5 白屏、按钮无反应时比截图更快定位原因。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      duration: {
        type: 'number',
        description: '采集时长毫秒数，默认 2500，上限 15000',
      },
      level: {
        type: 'string',
        description: '最低级别（verbose/info/warning/error），默认全部',
      },
      limit: { type: 'number', description: '最多返回多少条，默认 100' },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const duration = Math.min(
      Math.max(Number(args.duration) || 2500, 200),
      15000
    )
    const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
    const context = await openSession(args)
    const entries: any[] = []

    const levelRank: Record<string, number> = {
      verbose: 0,
      info: 1,
      warning: 2,
      error: 3,
    }
    const minLevel =
      typeof args.level === 'string' && args.level in levelRank
        ? levelRank[args.level]
        : 0

    const push = (item: any) => {
      if (entries.length >= 500) {
        return
      }
      const rank = levelRank[item.level] ?? 1
      if (rank < minLevel) {
        return
      }
      entries.push(item)
    }

    try {
      await context.session.send('Runtime.enable')
      await context.session.send('Log.enable').catch(() => null)

      context.session.onEvent((message) => {
        if (message.method === 'Runtime.consoleAPICalled') {
          const params = message.params || {}
          push({
            source: 'console',
            level: params.type || 'log',
            time: params.timestamp || null,
            text: (params.args || [])
              .map((arg: any) =>
                arg.value !== undefined
                  ? typeof arg.value === 'string'
                    ? arg.value
                    : JSON.stringify(arg.value)
                  : arg.description || arg.type
              )
              .join(' '),
          })
        } else if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params?.exceptionDetails || {}
          push({
            source: 'exception',
            level: 'error',
            text:
              details.exception?.description ||
              details.text ||
              'unknown exception',
            line: details.lineNumber,
            column: details.columnNumber,
            url: details.url,
          })
        } else if (message.method === 'Log.entryAdded') {
          const entry = message.params?.entry || {}
          push({
            source: entry.source || 'log',
            level: entry.level || 'info',
            text: entry.text || '',
            url: entry.url,
          })
        }
      })

      // 触发一次页面活动，确保懒加载/定时日志也能被捕获
      await context.session
        .send('Runtime.evaluate', {
          expression: 'void 0',
          returnByValue: true,
        })
        .catch(() => null)

      await new Promise((resolve) => setTimeout(resolve, duration))
    } finally {
      context.session.close()
    }

    const sliced = entries.slice(-limit)

    return jsonResult({
      ok: true,
      deviceId: context.deviceId,
      page: context.page,
      durationMs: duration,
      total: entries.length,
      returned: sliced.length,
      hasErrors: entries.some((entry) => entry.level === 'error'),
      entries: sliced,
      hint: sliced.length
        ? undefined
        : '时间窗内没有日志：可在采集期间用 aya_webview_eval 触发交互，或页面本身没有输出',
    })
  },
}

const networkLogs: McpTool = {
  name: 'aya_webview_network',
  description:
    '采集 WebView 页面在指定时间窗内的网络请求（URL、方法、状态码、耗时、失败原因、响应类型）。接口 401/500、请求 pending、跨域失败时比看截图直观。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      duration: {
        type: 'number',
        description: '采集时长毫秒数，默认 3000，上限 15000',
      },
      filter: {
        type: 'string',
        description: 'URL 子串过滤，如 /api/',
      },
      onlyFailed: {
        type: 'boolean',
        description: '只返回失败或状态码 >= 400 的请求',
      },
      limit: { type: 'number', description: '最多返回多少条，默认 100' },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const duration = Math.min(
      Math.max(Number(args.duration) || 3000, 200),
      15000
    )
    const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
    const keyword = String(args.filter || '').trim()
    const context = await openSession(args)

    const requests = new Map<string, any>()

    try {
      await context.session.send('Network.enable')

      context.session.onEvent((message) => {
        const params = message.params || {}
        const id = params.requestId
        if (!id) {
          return
        }

        if (message.method === 'Network.requestWillBeSent') {
          requests.set(id, {
            method: params.request?.method,
            url: params.request?.url,
            startTime: params.timestamp || params.wallTime || Date.now() / 1000,
            status: null as number | null,
            mimeType: '',
            failed: false,
            error: '',
          })
        } else if (message.method === 'Network.responseReceived') {
          const item = requests.get(id)
          if (item) {
            item.status = params.response?.status ?? null
            item.mimeType = params.response?.mimeType || ''
            item.endTime = params.timestamp || null
          }
        } else if (message.method === 'Network.loadingFailed') {
          const item = requests.get(id)
          if (item) {
            item.failed = true
            item.error = params.errorText || 'failed'
            item.endTime = params.timestamp || null
          }
        }
      })

      await new Promise((resolve) => setTimeout(resolve, duration))
    } finally {
      context.session.close()
    }

    let list = Array.from(requests.values())

    if (keyword) {
      list = list.filter((item) => (item.url || '').includes(keyword))
    }
    if (args.onlyFailed === true) {
      list = list.filter(
        (item) => item.failed || (typeof item.status === 'number' && item.status >= 400)
      )
    }

    const shaped = list.slice(-limit).map((item) => ({
      method: item.method,
      url: item.url,
      status: item.status,
      mimeType: item.mimeType,
      durationMs:
        item.endTime && item.startTime
          ? Math.round((item.endTime - item.startTime) * 1000)
          : null,
      failed: item.failed,
      error: item.error || undefined,
    }))

    return jsonResult({
      ok: true,
      deviceId: context.deviceId,
      page: context.page,
      durationMs: duration,
      total: list.length,
      returned: shaped.length,
      requests: shaped,
      hint: shaped.length
        ? undefined
        : '时间窗内没有请求：页面可能已加载完成，可在采集期间用 aya_webview_eval 触发一次交互',
    })
  },
}

const SNAPSHOT_JS = `
const limit = __LIMIT__;
const root = document.querySelector(__ROOT__) || document.body;
const out = [];
const seen = new Set();
const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[onclick],[contenteditable="true"]';
const nodes = root.querySelectorAll(sel);
for (let i = 0; i < nodes.length && out.length < limit; i++) {
  const el = nodes[i];
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) continue;
  if (rect.bottom < 0 || rect.top > innerHeight) continue;
  const key = Math.round(rect.x) + ':' + Math.round(rect.y) + ':' + el.tagName;
  if (seen.has(key)) continue;
  seen.add(key);
  const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  out.push({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || null,
    text: text || null,
    id: el.id || null,
    name: el.getAttribute('name') || null,
    href: el.getAttribute('href') || null,
    disabled: !!el.disabled,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height)
  });
}
return {
  title: document.title,
  url: location.href,
  readyState: document.readyState,
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.body ? document.body.scrollHeight : 0 },
  matched: nodes.length,
  nodes: out
};
`

const snapshot: McpTool = {
  name: 'aya_webview_snapshot',
  description:
    '把 WebView 页面里「可见且可交互」的元素（按钮/链接/输入框等）导出成精简结构：文本、id/name、href、是否禁用、以及视口内坐标。H5 场景下用它代替截图 + 视觉识别，再配合坐标点击或 aya_webview_eval 里的 querySelector 操作。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      selector: {
        type: 'string',
        description: '只在某个容器内查找，默认 document.body',
      },
      maxNodes: { type: 'number', description: '最多返回多少个元素，默认 120' },
      withHtml: {
        type: 'boolean',
        description: '同时返回容器的精简 HTML（去掉 script/style，默认 false）',
      },
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const maxNodes = Math.min(Math.max(Number(args.maxNodes) || 120, 1), 500)
    const selector = String(args.selector || '').trim() || 'body'
    const context = await openSession(args)

    try {
      const expression = `(async () => { ${SNAPSHOT_JS.replace(
        '__LIMIT__',
        String(maxNodes)
      ).replace('__ROOT__', JSON.stringify(selector))} })()`

      const result = await context.session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      const normalized = normalizeJsResult(result)

      if (normalized.exception) {
        throw new McpError(
          'INTERNAL',
          `页面快照失败：${normalized.exception}（selector 可能不存在）`
        )
      }

      const payload: any = {
        ok: true,
        deviceId: context.deviceId,
        page: context.page,
        ...(normalized.value as Record<string, unknown>),
      }

      if (args.withHtml === true) {
        const html = await context.session.send('Runtime.evaluate', {
          expression: `(async () => {
            const el = document.querySelector(${JSON.stringify(selector)}) || document.body;
            const clone = el.cloneNode(true);
            clone.querySelectorAll('script,style,svg,noscript').forEach((n) => n.remove());
            return clone.outerHTML.replace(/\\s+/g, ' ').slice(0, 20000);
          })()`,
          awaitPromise: true,
          returnByValue: true,
        })
        payload.html = normalizeJsResult(html).value || ''
      }

      return jsonResult(payload)
    } finally {
      context.session.close()
    }
  },
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 统一 Runtime.evaluate：包成 async IIFE，exceptionDetails 转成可读错误
async function evaluate(
  session: { send: (method: string, params?: any, timeout?: number) => Promise<any> },
  expression: string,
  timeout = 15000
) {
  const result = await session.send(
    'Runtime.evaluate',
    {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeout
  )
  const normalized = normalizeJsResult(result)

  if (normalized.exception) {
    throw new McpError('INTERNAL', `JS 执行异常：${normalized.exception}`)
  }

  return normalized.value
}

const ELEMENT_INFO_JS = `
const el = document.querySelector(__SEL__);
if (!el) return { attached: false, visible: false };
const style = getComputedStyle(el);
const rect = el.getBoundingClientRect();
return {
  attached: true,
  visible:
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) > 0 &&
    rect.width > 1 &&
    rect.height > 1,
  tag: el.tagName.toLowerCase(),
  text: (el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
};
`

const waitFor: McpTool = {
  name: 'aya_webview_wait',
  description:
    '等待 DOM 元素出现/可见/消失（默认 visible），命中立即返回，比反复调 aya_webview_snapshot 便宜得多。state: visible（存在且可见）、hidden（不存在或不可见）、attached（存在）、detached（不存在）。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      selector: {
        type: 'string',
        description: 'CSS 选择器，如 #submit、[data-testid="ok"]',
      },
      state: {
        type: 'string',
        enum: ['visible', 'hidden', 'attached', 'detached'],
        description: '等待的状态，默认 visible',
      },
      timeout: {
        type: 'number',
        description: '最长等待毫秒数，默认 10000，上限 30000',
      },
      interval: { type: 'number', description: '轮询间隔毫秒数，默认 150' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 60000,
  handler: async (args) => {
    const selector = String(args.selector || '').trim()
    if (!selector) {
      throw new McpError('INVALID_ARGS', 'selector 不能为空')
    }

    const state = ['visible', 'hidden', 'attached', 'detached'].includes(
      String(args.state)
    )
      ? String(args.state)
      : 'visible'
    const timeout = Math.min(
      Math.max(Math.floor(Number(args.timeout) || 10000), 100),
      30000
    )
    const interval = Math.min(
      Math.max(Math.floor(Number(args.interval) || 150), 50),
      2000
    )

    const context = await openSession(args)
    const started = Date.now()
    let attempts = 0
    let last: any = null

    try {
      while (Date.now() - started < timeout) {
        attempts++
        last = await evaluate(
          context.session,
          ELEMENT_INFO_JS.replace('__SEL__', () => JSON.stringify(selector))
        )

        const attached = last && last.attached
        const visible = attached && last.visible
        const hit =
          state === 'attached'
            ? attached
            : state === 'detached'
              ? !attached
              : state === 'hidden'
                ? !visible
                : visible

        if (hit) {
          return jsonResult({
            ok: true,
            deviceId: context.deviceId,
            page: context.page,
            selector,
            state,
            hit: true,
            attempts,
            waitedMs: Date.now() - started,
            element: last,
          })
        }

        await sleep(interval)
      }
    } finally {
      context.session.close()
    }

    return jsonResult({
      ok: true,
      deviceId: context.deviceId,
      page: context.page,
      selector,
      state,
      hit: false,
      attempts,
      waitedMs: Date.now() - started,
      element: last,
      hint: '超时未命中：确认 selector 正确，或先用 aya_webview_snapshot 看页面实际结构',
    })
  },
}

const click: McpTool = {
  name: 'aya_webview_click',
  description:
    '点击 DOM 元素（默认 element.click()，与用户点击同样触发事件；viaMouse:true 时改用 CDP Input.dispatchMouseEvent 模拟真实鼠标）。支持 index 选择同选择器的第 N 个元素，返回点击前的元素信息与视口坐标。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      selector: { type: 'string', description: 'CSS 选择器' },
      index: {
        type: 'number',
        description: '同选择器命中多个时的下标（0 基），默认 0',
      },
      viaMouse: {
        type: 'boolean',
        description: '用真实鼠标事件点击（适用于点击后依赖 pointerdown/mousedown 的组件）',
      },
      timeout: { type: 'number', description: '命令超时毫秒数，默认 15000' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const selector = String(args.selector || '').trim()
    if (!selector) {
      throw new McpError('INVALID_ARGS', 'selector 不能为空')
    }
    const index = Math.max(Math.floor(Number(args.index) || 0), 0)
    const timeout = Math.min(Math.max(Number(args.timeout) || 15000, 1000), 60000)
    const context = await openSession(args)

    try {
      const info: any = await evaluate(
        context.session,
        `
const list = document.querySelectorAll(__SEL__);
const el = list[__IDX__];
if (!el) return { found: false, total: list.length };
el.scrollIntoView({ block: 'center', inline: 'center' });
await new Promise((r) => setTimeout(r, 50));
const rect = el.getBoundingClientRect();
const info = {
  found: true,
  total: list.length,
  tag: el.tagName.toLowerCase(),
  text: (el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  id: el.id || null,
  disabled: !!el.disabled,
  rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
};
window.__ayaClickTarget = el;
return info;
`.replace('__SEL__', () => JSON.stringify(selector)).replace('__IDX__', String(index)),
        timeout
      )

      if (!info || !info.found) {
        throw new McpError(
          'NOT_FOUND',
          `选择器 ${selector}[${index}] 未命中（共 ${(info && info.total) || 0} 个）`
        )
      }
      if (info.disabled) {
        throw new McpError(
          'INVALID_ARGS',
          `目标元素处于 disabled 状态：${info.tag} ${info.text || ''}`
        )
      }

      if (args.viaMouse === true) {
        const x = info.rect.x + info.rect.w / 2
        const y = info.rect.y + info.rect.h / 2
        const press = { x, y, button: 'left', clickCount: 1 }
        await context.session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...press,
        })
        await context.session.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...press,
        })
        await context.session.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...press,
        })
      } else {
        await evaluate(
          context.session,
          'const el = window.__ayaClickTarget; if (!el) return false; el.click(); return true;',
          timeout
        )
      }

      return jsonResult({
        ok: true,
        deviceId: context.deviceId,
        page: context.page,
        selector,
        index,
        viaMouse: args.viaMouse === true,
        element: info,
      })
    } finally {
      context.session.close()
    }
  },
}

const input: McpTool = {
  name: 'aya_webview_input',
  description:
    '给输入框/可编辑元素赋值并触发 input/change 事件（React 受控组件也能生效），返回写入前后的值用于校验。clear 默认 true（覆盖原值）；submit:true 时额外派发 Enter 并尝试 form.requestSubmit()。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      selector: { type: 'string', description: '输入框的 CSS 选择器' },
      value: { type: 'string', description: '要写入的文本' },
      clear: {
        type: 'boolean',
        description: '是否覆盖原值（默认 true）；false 表示追加到末尾',
      },
      submit: { type: 'boolean', description: '写入后是否提交（Enter / form.submit）' },
      timeout: { type: 'number', description: '命令超时毫秒数，默认 15000' },
    },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const selector = String(args.selector || '').trim()
    if (!selector) {
      throw new McpError('INVALID_ARGS', 'selector 不能为空')
    }
    const value = String(args.value ?? '')
    const timeout = Math.min(Math.max(Number(args.timeout) || 15000, 1000), 60000)
    const context = await openSession(args)

    try {
      const result: any = await evaluate(
        context.session,
        `
const el = document.querySelector(__SEL__);
if (!el) return { found: false };
el.focus();
const read = () => (el.value !== undefined && el.value !== null ? String(el.value) : (el.textContent || ''));
const before = read();
if (__CLEAR__) {
  if (el.value !== undefined) {
    el.value = '';
  } else {
    el.textContent = '';
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const next = __CLEAR__ ? __VALUE__ : before + __VALUE__;
if (el.value !== undefined) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, next);
  } else {
    el.value = next;
  }
} else {
  el.textContent = next;
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
let submitted = false;
if (__SUBMIT__) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  if (el.form && typeof el.form.requestSubmit === 'function') {
    el.form.requestSubmit();
  }
  submitted = true;
}
const after = read();
return {
  found: true,
  tag: el.tagName.toLowerCase(),
  before,
  after,
  matched: after === next,
  submitted
};
`
          .replace('__SEL__', () => JSON.stringify(selector))
          .replace(/__VALUE__/g, () => JSON.stringify(value))
          .replace('__CLEAR__', args.clear === false ? 'false' : 'true')
          .replace('__SUBMIT__', args.submit === true ? 'true' : 'false'),
        timeout
      )

      if (!result || !result.found) {
        throw new McpError('NOT_FOUND', `选择器 ${selector} 未命中`)
      }

      return jsonResult({
        ok: true,
        deviceId: context.deviceId,
        page: context.page,
        selector,
        ...result,
        hint: result.matched
          ? undefined
          : '读回值与写入值不一致：元素可能是只读/自定义组件，可改用 aya_webview_eval 直接派发业务事件',
      })
    } finally {
      context.session.close()
    }
  },
}

const navigate: McpTool = {
  name: 'aya_webview_navigate',
  description:
    '页面导航：navigate 打开 URL、reload 刷新、back/forward 前进后退。会等待 document.readyState=complete（或超时），返回最终 URL/标题，避免再调一次 eval 确认。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      package: packageProperty,
      pid: { type: 'number', description: '直接指定进程 pid' },
      url: urlMatchProperty,
      webSocketDebuggerUrl: { type: 'string', description: '直接指定调试地址' },
      action: {
        type: 'string',
        enum: ['navigate', 'reload', 'back', 'forward'],
        description: '默认 navigate',
      },
      target: {
        type: 'string',
        description: 'navigate 时的目标 URL（与工具级的 url（用于挑选 WebView）不同）',
      },
      hardReload: {
        type: 'boolean',
        description: 'reload 时忽略缓存（ignoreCache）',
      },
      timeout: {
        type: 'number',
        description: '等待加载完成的毫秒数，默认 10000，上限 30000',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 60000,
  handler: async (args) => {
    const action = ['navigate', 'reload', 'back', 'forward'].includes(
      String(args.action)
    )
      ? String(args.action)
      : 'navigate'
    const timeout = Math.min(
      Math.max(Math.floor(Number(args.timeout) || 10000), 500),
      30000
    )
    const target = String(args.target || '').trim()

    if (action === 'navigate' && !target) {
      throw new McpError('INVALID_ARGS', 'action=navigate 时必须传 target URL')
    }

    const context = await openSession(args)
    const started = Date.now()

    try {
      await context.session.send('Page.enable').catch(() => null)

      if (action === 'navigate') {
        const result = await context.session.send(
          'Page.navigate',
          { url: target },
          timeout
        )
        if (result && result.errorText) {
          throw new McpError(
            'INTERNAL',
            `导航失败：${result.errorText}（${target}）`
          )
        }
      } else if (action === 'reload') {
        await context.session.send(
          'Page.reload',
          { ignoreCache: args.hardReload === true },
          timeout
        )
      } else {
        await evaluate(
          context.session,
          `history.${action}(); return true;`,
          timeout
        ).catch(() => null)
      }

      let readyState = ''
      while (Date.now() - started < timeout) {
        readyState = String(
          await evaluate(context.session, 'return document.readyState;').catch(
            () => ''
          )
        )
        if (readyState === 'complete') {
          break
        }
        await sleep(150)
      }

      const info: any = await evaluate(
        context.session,
        'return { url: location.href, title: document.title, readyState: document.readyState };'
      ).catch(() => null)

      return jsonResult({
        ok: true,
        deviceId: context.deviceId,
        action,
        target: action === 'navigate' ? target : null,
        waitedMs: Date.now() - started,
        loaded: (info && info.readyState) === 'complete',
        url: (info && info.url) || null,
        title: (info && info.title) || null,
        readyState: (info && info.readyState) || null,
        hint:
          info && info.readyState === 'complete'
            ? undefined
            : '等待 readyState=complete 超时：页面可能仍在加载，可先 aya_webview_wait 等关键元素',
      })
    } finally {
      context.session.close()
    }
  },
}

export default [
  listWebviews,
  snapshot,
  evalJs,
  waitFor,
  click,
  input,
  navigate,
  consoleLogs,
  networkLogs,
]
