import os from 'node:os'
import { resolveResources } from 'share/main/lib/util'
import { IMcpConfigs } from 'common/types'
import { getPort, getToken, ensureToken, isLan } from './state'

// 局域网模式下返回本机在局域网内的 IPv4 地址，方便其他机器复制连接地址；
// 取第一个非回环、非链路本地（169.254.*）的 IPv4；找不到时回退到 127.0.0.1
export function getLanIp(): string {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        return info.address
      }
    }
  }

  return '127.0.0.1'
}

export function getEndpoint() {
  const host = isLan() ? getLanIp() : '127.0.0.1'

  return `http://${host}:${getPort()}/mcp`
}

export function getBridgePath() {
  return resolveResources('mcp/aya-mcp-stdio.cjs')
}

function stringify(config: unknown) {
  return JSON.stringify(config, null, 2)
}

export function getConfigs(): IMcpConfigs {
  const port = getPort()
  const token = ensureToken()
  const url = getEndpoint()
  const bridge = getBridgePath()
  const exe = process.execPath

  const stdio = stringify({
    mcpServers: {
      aya: {
        type: 'stdio',
        command: exe,
        args: [bridge, `--url=${url}`, `--token=${token}`],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          AYA_MCP_URL: url,
          AYA_MCP_TOKEN: token,
        },
        description: 'AYA Android device control',
      },
    },
  })

  const node = stringify({
    mcpServers: {
      aya: {
        type: 'stdio',
        command: 'node',
        args: [bridge, `--url=${url}`, `--token=${token}`],
        description: 'AYA Android device control (no env fallback)',
      },
    },
  })

  const http = stringify({
    mcpServers: {
      aya: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
        description: 'AYA Android device control',
      },
    },
  })

  return { port, token: getToken(), stdio, node, http }
}
