import each from 'licia/each'
import trim from 'licia/trim'
import contain from 'licia/contain'
import isArr from 'licia/isArr'
import map from 'licia/map'
import unique from 'licia/unique'
import toNum from 'licia/toNum'
import singleton from 'licia/singleton'
import axios from 'axios'
import { shell, forwardTcp } from './base'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetWebviews, IWebview } from 'common/types'

// socket 不存在时请求会很快失败，超时只是兜底
const REQUEST_TIMEOUT = 800

// 常见的 devtools socket 命名：
//   webview_devtools_remote_<pid>            系统 WebView
//   content_shell_devtools_remote / chrome_devtools_remote   不带 pid
const SOCKET_PATTERN = /devtools_remote(?:_(\d+))?$/

const PIDLESS_SOCKETS = [
  'content_shell_devtools_remote',
  'chrome_devtools_remote',
]

interface IProcessEntry {
  pid: number
  name: string
}

async function listProcesses(deviceId: string): Promise<IProcessEntry[]> {
  let output = ''
  try {
    output = await shell(deviceId, 'ps -A')
  } catch {
    output = await shell(deviceId, 'ps')
  }

  const processes: IProcessEntry[] = []
  each(output.split('\n'), (line) => {
    // USER PID PPID VSZ RSS WCHAN ADDR S NAME
    const parts = trim(line).split(/\s+/)
    if (parts.length < 2) {
      return
    }
    const pid = toNum(parts[1])
    if (!pid) {
      return
    }
    processes.push({ pid, name: parts[parts.length - 1] })
  })

  return processes
}

// com.foo:remote -> com.foo
function baseName(name: string) {
  const index = name.indexOf(':')
  return index === -1 ? name : name.substring(0, index)
}

// WebView 的调试 socket 由持有 WebView 的进程创建，前台应用可能同时存在
// 多个进程（:sandbox、:remote ...），因此同包名的进程都要作为候选
async function getCandidatePids(deviceId: string, pid: number) {
  const pids = [pid]

  let processes: IProcessEntry[] = []
  try {
    processes = await listProcesses(deviceId)
  } catch {
    return pids
  }

  let base = ''
  each(processes, (process) => {
    if (process.pid === pid) {
      base = baseName(process.name)
    }
  })

  if (base) {
    each(processes, (process) => {
      if (process.pid !== pid && baseName(process.name) === base) {
        pids.push(process.pid)
      }
    })
  }

  return unique(pids) as number[]
}

// 从 /proc/net/unix 里找 devtools socket。带 pid 的按进程匹配，
// 不带 pid 的（content_shell / chrome）无法归因，作为兜底候选
async function listDevtoolsSockets(deviceId: string, pids: number[]) {
  const matched: string[] = []
  const pidless: string[] = []

  let output = ''
  try {
    output = await shell(deviceId, 'cat /proc/net/unix')
  } catch {
    return { matched, pidless }
  }

  each(output.split('\n'), (line) => {
    line = trim(line)
    const index = line.indexOf('@')
    if (index === -1) {
      return
    }
    const name = trim(line.substring(index + 1))
    const result = name.match(SOCKET_PATTERN)
    if (!result) {
      return
    }
    if (result[1]) {
      if (contain(pids, toNum(result[1]))) {
        matched.push(name)
      }
    } else {
      pidless.push(name)
    }
  })

  return {
    matched: unique(matched) as string[],
    pidless: unique(pidless) as string[],
  }
}

function merge(target: IWebview[], list: IWebview[]) {
  each(list, (item) => {
    const key = item.webSocketDebuggerUrl || item.url
    const exist = target.some((webview) => {
      return (webview.webSocketDebuggerUrl || webview.url) === key
    })
    if (!exist) {
      target.push(item)
    }
  })
}

async function requestPages(port: number) {
  const webviews: IWebview[] = []

  try {
    const { data } = await axios.get(`http://127.0.0.1:${port}/json`, {
      timeout: REQUEST_TIMEOUT,
    })
    if (!isArr(data)) {
      return webviews
    }
    each(data, (item: IWebview) => {
      if (item && item.url) {
        webviews.push(item)
      }
    })
  } catch {
    // socket 不存在或应用没有开启 WebView 调试，忽略即可
  }

  return webviews
}

async function requestWebviews(deviceId: string, sockets: string[]) {
  const webviews: IWebview[] = []
  if (!sockets.length) {
    return webviews
  }

  // adb forward 很轻，串行建立映射；/json 请求并行发出，
  // 避免多个不存在的 socket 逐个超时叠加
  const ports: number[] = []
  for (const socket of sockets) {
    try {
      ports.push(await forwardTcp(deviceId, `localabstract:${socket}`))
    } catch {
      // 映射失败，跳过
    }
  }

  const results = await Promise.all(map(ports, (port) => requestPages(port)))
  each(results, (list) => merge(webviews, list))

  return webviews
}

// 未做 singleton 的原始实现：MCP 需要每次拿到最新页面列表
const fetchWebviews: IpcGetWebviews = async (
  deviceId: string,
  pid: number
) => {
  const webviews: IWebview[] = []
  const pids = await getCandidatePids(deviceId, pid)

  // 1. 老系统：/proc/net/unix 能直接看到 socket 名
  const { matched, pidless } = await listDevtoolsSockets(deviceId, pids)
  merge(webviews, await requestWebviews(deviceId, matched))
  // 不带 pid 的 socket 有可能是别的应用的，只在没匹配到前台应用时兜底
  if (!webviews.length) {
    merge(webviews, await requestWebviews(deviceId, pidless))
  }

  // 2. 新系统会隐藏 socket 名，按命名规则直接探测
  if (!webviews.length) {
    const candidates = unique([
      ...pids.map((candidate) => `webview_devtools_remote_${candidate}`),
      ...PIDLESS_SOCKETS,
    ]) as string[]
    merge(webviews, await requestWebviews(deviceId, candidates))
  }

  return webviews
}

const getWebviews = singleton(fetchWebviews)

export { fetchWebviews }

export function init() {
  handleEvent('getWebviews', getWebviews)
}
