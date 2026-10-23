import { app } from 'electron'
import { handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import log from 'share/common/log'
import { getSettingsStore } from '../store'
import { IMcpConfigs, IMcpStatus } from 'common/types'
import * as server from './server'
import { getConfigs, getEndpoint } from './config'
import {
  ensureToken,
  getPort,
  isAllowWrite,
  isEnabled,
  isLan,
  resetToken,
  runtime,
} from './state'
import { getVisibleTools } from './tools'

const logger = log('mcp')
const settingsStore = getSettingsStore()

function buildStatus(): IMcpStatus {
  const port = getPort()

  return {
    running: runtime.running,
    enabled: !!settingsStore.get('mcpEnabled'),
    lan: isLan(),
    port,
    url: getEndpoint(),
    allowWrite: isAllowWrite(),
    toolCount: getVisibleTools().length,
    rev: runtime.rev,
    ...(runtime.error ? { error: runtime.error } : {}),
  }
}

function notify() {
  window.sendAll('changeMcpStatus', buildStatus())
}

function notifyToolsChanged() {
  runtime.rev++
  const status = buildStatus()
  server.broadcast({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    params: {
      allowWrite: status.allowWrite,
      toolCount: status.toolCount,
      rev: runtime.rev,
    },
  })
  notify()

  return status
}

export async function start(): Promise<IMcpStatus> {
  if (runtime.running) {
    return buildStatus()
  }

  const port = getPort()
  try {
    ensureToken()
    await server.start(port, isLan())
    runtime.running = true
    runtime.error = ''
    logger.info('server started on port', port)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    runtime.running = false
    runtime.error =
      e.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用，请更换端口后重试`
        : `启动失败：${e.message}`
    logger.error('start failed', runtime.error)
  }

  const status = buildStatus()
  notify()

  return status
}

export async function stop(): Promise<IMcpStatus> {
  if (!runtime.running) {
    return buildStatus()
  }

  await server.stop()
  runtime.running = false
  runtime.error = ''
  logger.info('server stopped')
  const status = buildStatus()
  notify()

  return status
}

async function restartIfRunning() {
  if (!runtime.running) {
    return
  }
  await server.stop()
  runtime.running = false
  await start()
}

export async function init() {
  logger.info('init', `enabled=${isEnabled()} port=${getPort()}`)

  handleEvent('mcpGetStatus', async () => buildStatus())

  // getConfigs() 内部会 ensureToken()，首次获取即生成并持久化令牌
  handleEvent('mcpGetConfigs', async () => getConfigs())

  handleEvent('mcpSetEnabled', async (enabled: boolean) => {
    settingsStore.set('mcpEnabled', !!enabled)

    return enabled ? start() : stop()
  })

  handleEvent('mcpSetAllowWrite', async (allowWrite: boolean) => {
    settingsStore.set('mcpAllowWrite', !!allowWrite)

    return notifyToolsChanged()
  })

  handleEvent('mcpSetPort', async (port: number) => {
    const next = Math.round(Number(port))
    if (!(next >= 1024 && next <= 65535)) {
      return buildStatus()
    }
    settingsStore.set('mcpPort', next)
    await restartIfRunning()

    return buildStatus()
  })

  handleEvent('mcpSetLan', async (lan: boolean) => {
    settingsStore.set('mcpLan', !!lan)

    if (lan) {
      // 局域网模式需要 0.0.0.0 监听，必须重启才能让新的 bind 地址生效
      await restartIfRunning()
    } else if (runtime.running) {
      // 关闭局域网：重新绑定回 127.0.0.1
      await restartIfRunning()
    }

    return buildStatus()
  })

  handleEvent('mcpResetToken', async (): Promise<IMcpConfigs> => {
    resetToken()
    server.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/token_changed',
      params: { rev: ++runtime.rev },
    })

    return getConfigs()
  })

  app.on('will-quit', () => {
    server.stop()
  })

  if (settingsStore.get('mcpEnabled')) {
    await start()
  }

  notify()
}
