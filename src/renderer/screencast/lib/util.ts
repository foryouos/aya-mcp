import {
  Consumable,
  ReadableStream,
  WritableStream,
  ReadableWritablePair,
} from '@yume-chan/stream-extra'
import type { ISocketLike } from 'share/preload/node'
import log from 'share/common/log'

const logger = log('screencastSocket')

/**
 * preload 里的 socket 壳是手写的，历史上缺过 off / destroy / isDestroyed。
 * 这里统一做兼容判断，避免渲染进程用上新写法、preload 还是旧版本时直接抛错。
 */
function isSocketDestroyed(socket: any) {
  if (typeof socket.isDestroyed === 'function') {
    return socket.isDestroyed()
  }
  return !!socket.destroyed
}

function isSocketWritableEnded(socket: any) {
  if (typeof socket.isWritableEnded === 'function') {
    return socket.isWritableEnded()
  }
  return !!socket.writableEnded
}

export { isSocketDestroyed }

/**
 * socket 生命周期比 stream 长：关闭窗口、移除设备、重启会话时 socket 还在
 * 收数据，而 stream 已经被 close/cancel。此时再 enqueue 会抛
 * "Cannot enqueue a chunk into a closed readable stream" 并刷屏日志。
 * 所以必须用 done 标志过滤，并在结束后解绑所有监听器。
 */
export function socketToReadableStream(socket: ISocketLike) {
  let done = false
  let detach = () => {}

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (data: Uint8Array) => {
        if (done) {
          return
        }
        try {
          controller.enqueue(data)
        } catch {
          // 下游已取消，残余数据直接丢弃
          done = true
          detach()
        }
      }
      const onEnd = () => {
        if (done) {
          return
        }
        done = true
        detach()
        try {
          controller.close()
        } catch {
          // 已经关闭或已取消
        }
      }
      const onError = (e: Error) => {
        if (done) {
          return
        }
        done = true
        detach()
        try {
          controller.error(e)
        } catch {
          // 已经关闭或已取消
        }
      }

      detach = () => {
        if (typeof socket.off !== 'function') {
          return
        }
        socket.off('data', onData)
        socket.off('end', onEnd)
        socket.off('close', onEnd)
        socket.off('error', onError)
      }

      socket.on('data', onData)
      socket.on('end', onEnd)
      // destroy 过的 socket 可能只有 close 没有 end，不接管会让下游一直挂起
      socket.on('close', onEnd)
      socket.on('error', onError)
    },
    cancel() {
      done = true
      detach()
      if (typeof socket.destroy === 'function') {
        socket.destroy()
      }
    },
  })
}

/**
 * video 元素是撑满格子 + object-fit: contain 的，
 * 元素范围内可能有一圈 letterbox 黑边。这里算出画面真正占据的矩形，
 * 用来区分「点在画面上」和「点在黑边上」。
 */
export function getVideoFrameRect(el: HTMLVideoElement) {
  const rect = el.getBoundingClientRect()
  const screenWidth = el.width
  const screenHeight = el.height
  if (!screenWidth || !screenHeight) {
    return rect
  }

  const screenRatio = screenWidth / screenHeight
  const rectRatio = rect.width / rect.height
  let width: number
  let height: number
  if (screenRatio > rectRatio) {
    // 画面比格子更宽：宽度到顶，上下留黑边
    width = rect.width
    height = rect.width / screenRatio
  } else {
    // 画面比格子更窄（竖屏）：高度到顶，左右留黑边
    height = rect.height
    width = rect.height * screenRatio
  }

  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  }
}

export function isInsideVideoFrame(
  el: HTMLVideoElement,
  clientX: number,
  clientY: number
) {
  const frame = getVideoFrameRect(el)
  return (
    clientX >= frame.x &&
    clientX <= frame.x + frame.width &&
    clientY >= frame.y &&
    clientY <= frame.y + frame.height
  )
}

export function socketToWritableStream(socket: ISocketLike) {
  return new WritableStream<Consumable<Uint8Array>>({
    write(chunk) {
      return new Promise((resolve) => {
        if (isSocketDestroyed(socket) || isSocketWritableEnded(socket)) {
          resolve()
          return
        }
        socket.write(chunk.value, (err) => {
          // 设备已经断开时控制指令（触摸/按键）丢掉就行。
          // 这里不能 reject：调用方是散落在各处的注入调用，
          // reject 只会变成刷屏的 unhandled rejection，
          // 真正的断线由 socket 的 close 事件上报
          if (err) {
            logger.debug('control write failed', err.message)
          }
          resolve()
        })
      })
    },
    close() {
      if (!isSocketDestroyed(socket) && typeof socket.end === 'function') {
        socket.end()
      }
    },
    abort() {
      if (typeof socket.destroy === 'function') {
        socket.destroy()
      }
    },
  })
}

export function socketToReadableWritablePair(
  socket: ISocketLike
): ReadableWritablePair<Uint8Array, Consumable<Uint8Array>> {
  return {
    readable: socketToReadableStream(socket),
    writable: socketToWritableStream(socket),
  }
}
