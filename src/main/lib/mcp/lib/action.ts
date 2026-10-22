import { invalidateDump } from './dump'
import { invalidateSnapshot } from './snapshot'

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function afterInput(deviceId: string, settle: number = 300) {
  invalidateDump(deviceId)
  invalidateSnapshot(deviceId)

  if (settle > 0) {
    await sleep(settle)
  }

  return settle
}
