import { resolveResources } from 'share/main/lib/util'
import { IMcpConfigs } from 'common/types'
import { getPort, getToken, ensureToken } from './state'

export function getEndpoint() {
  return `http://127.0.0.1:${getPort()}/mcp`
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
  const url = `http://127.0.0.1:${port}/mcp`
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
