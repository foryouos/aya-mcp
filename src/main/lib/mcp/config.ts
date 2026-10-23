import os from 'node:os'
import dgram from 'node:dgram'
import { resolveResources } from 'share/main/lib/util'
import { IMcpConfigs } from 'common/types'
import { getPort, getToken, ensureToken, isLan } from './state'

// 局域网模式下返回本机用于对外连接的 IPv4 地址，方便其他机器复制连接地址。
// 优先用「向外部地址发起 UDP connect」取得默认出口网卡的 IP，避免把
// Docker/VPN/虚拟网卡（如 172.19.0.1）误当成局域网地址返回——那些地址
// 对其他机器并不可达。拿不到时再兜底遍历非回环 IPv4。
export function getLanIp(): string {
  try {
    const sock = dgram.createSocket('udp4')
    sock.connect(8, '8.8.8.8') // 仅确定路由，不会真正发包
    const addr = sock.address().address
    sock.close()
    if (addr && addr !== '0.0.0.0' && !addr.startsWith('127.')) {
      return addr
    }
  } catch {
    // ignore，走兜底
  }

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

// 返回本机所有可用于局域网连接的 IPv4（排除回环与链路本地），供 UI 罗列，
// 当自动选出的地址不可达时，用户可手动改用其中任意一个（服务监听 0.0.0.0）。
export function getLanIps(): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (
        info.family === 'IPv4' &&
        !info.internal &&
        !info.address.startsWith('169.254.') &&
        !seen.has(info.address)
      ) {
        seen.add(info.address)
        result.push(info.address)
      }
    }
  }

  return result
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
