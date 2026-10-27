// 注入通道（常驻 UiAutomation）的能力熔断。
//
// 与 dump.ts 的 accessibilityBlocked 同一套思路：某台设备上如果 UiAutomation
// 注入/截图被 ROM 拒绝，就熔断 5 分钟直接走 adb shell 旧路径，
// 避免每次调用都白付一次失败的 RPC（尤其 tap 这种高频动作）。

import log from 'share/common/log'

const logger = log('mcp')

const BLOCK_MS = 5 * 60 * 1000

const blocked: { [deviceId: string]: number } = {}
const shotBlocked: { [deviceId: string]: number } = {}

export type InjectVia = 'uiAutomation' | 'shell'

export function isInjectBlocked(deviceId: string) {
  return Date.now() < (blocked[deviceId] || 0)
}

export function blockInject(deviceId: string) {
  blocked[deviceId] = Date.now() + BLOCK_MS
}

// 设备端 takeScreenshot 与注入能力互相独立（个别 ROM 只允许其中一种），单独熔断
export function isShotBlocked(deviceId: string) {
  return Date.now() < (shotBlocked[deviceId] || 0)
}

export function blockShot(deviceId: string) {
  shotBlocked[deviceId] = Date.now() + BLOCK_MS
}

export function resetInjectBlock(deviceId?: string) {
  if (deviceId) {
    delete blocked[deviceId]
    delete shotBlocked[deviceId]
    return
  }

  Object.keys(blocked).forEach((key) => delete blocked[key])
  Object.keys(shotBlocked).forEach((key) => delete shotBlocked[key])
}

export interface IInjectOutcome<T> {
  value: T
  via: InjectVia
  error?: string
}

/**
 * 先走注入通道，失败即熔断并降级到 shell。
 * `task` 抛错视为通道不可用（不是操作失败），因此 fallback 一定会被执行一次。
 */
export async function injectOrFallback<T>(
  deviceId: string,
  label: string,
  task: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<IInjectOutcome<T>> {
  if (!isInjectBlocked(deviceId)) {
    let lastError = ''

    // 首次调用常常赶上设备端服务冷启动（push + app_process 需要 1-2s），
    // 这时连不上并不代表通道不可用，重试一次再决定是否熔断
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { value: await task(), via: 'uiAutomation' }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
    }

    blockInject(deviceId)
    logger.info(`${label} inject unavailable, fallback to shell`, lastError)

    return { value: await fallback(), via: 'shell', error: lastError }
  }

  return { value: await fallback(), via: 'shell' }
}
