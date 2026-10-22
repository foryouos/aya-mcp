import * as base from '../../adb/base'
import { getTopPackage } from '../../adb/package'
import { fetchWebviews } from '../../adb/webview'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

async function resolvePid(deviceId: string, packageName: string) {
  const output = await base.shell(deviceId, `pidof ${packageName}`)
  const pid = Number(String(output).trim().split(/\s+/)[0])

  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

const listWebviews: McpTool = {
  name: 'aya_list_webviews',
  description:
    '列出应用内可调试的 WebView 页面（标题、URL、devtoolsFrontendUrl、webSocketDebuggerUrl）。H5 页面出问题时先用它把页面 URL 和调试地址拿出来（在 Chrome 打开 devtoolsFrontendUrl 即可远程调试）。默认取前台应用。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: '设备 id。省略时使用 AYA 当前选中设备',
      },
      package: {
        type: 'string',
        description: '目标应用包名；省略时使用前台应用',
      },
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

    return jsonResult({
      ok: true,
      deviceId,
      package: packageName || null,
      pid,
      total: webviews.length,
      webviews: webviews.map((item) => ({
        title: item.title,
        url: item.url,
        devtoolsFrontendUrl: item.devtoolsFrontendUrl,
        webSocketDebuggerUrl: item.webSocketDebuggerUrl,
        faviconUrl: item.faviconUrl || null,
      })),
      hint: webviews.length
        ? '如需远程调试，在 Chrome 打开 devtoolsFrontendUrl（本机已建立 adb 端口转发）'
        : '未发现 WebView：应用可能未启用 WebView 调试，需在代码里调用 WebView.setWebContentsDebuggingEnabled(true)',
    })
  },
}

export default [listWebviews]
