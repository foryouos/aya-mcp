import { randomBytes } from 'node:crypto'
import { connect as netConnect, Socket } from 'node:net'
import { McpError } from './result'

// 最小化 WebSocket + CDP 客户端：项目里没有 ws 依赖，
// 而 WebView 调试只需要「发 JSON-RPC、收 JSON-RPC」，手写 RFC6455 足够。

const MAX_LOG_EVENTS = 2000

interface IPending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface ICdpSession {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeout?: number
  ): Promise<any>
  events: any[]
  onEvent(listener: (message: any) => void): () => void
  close(): void
  closed: boolean
}

function encodeFrame(text: string) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length

  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x81

  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    masked[i] = payload[i] ^ mask[i & 3]
  }

  return Buffer.concat([header, mask, masked])
}

export function connectCdp(wsUrl: string, timeout = 8000): Promise<ICdpSession> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(wsUrl)
    } catch {
      reject(new McpError('INVALID_ARGS', `无效的 webSocketDebuggerUrl：${wsUrl}`))
      return
    }

    const socket: Socket = netConnect({
      host: url.hostname,
      port: Number(url.port) || 80,
    })
    socket.setNoDelay(true)

    const pending = new Map<number, IPending>()
    const listeners: Array<(message: any) => void> = []
    const events: any[] = []
    let messageId = 0
    let handshaken = false
    let buffer = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let closed = false

    const fail = (error: Error) => {
      if (closed) {
        return
      }
      closed = true
      pending.forEach((item) => {
        clearTimeout(item.timer)
        item.reject(error)
      })
      pending.clear()
      socket.destroy()
      reject(error)
    }

    const session: ICdpSession = {
      get closed() {
        return closed
      },
      events,
      send(method, params = {}, commandTimeout = 15000) {
        if (closed) {
          return Promise.reject(
            new McpError('DEVICE_OFFLINE', 'CDP 连接已关闭，请重新调用')
          )
        }

        const id = ++messageId

        return new Promise((resolveSend, rejectSend) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            rejectSend(
              new McpError(
                'TIMEOUT',
                `CDP 命令超时（${method}，${commandTimeout}ms）`
              )
            )
          }, commandTimeout)

          pending.set(id, { resolve: resolveSend, reject: rejectSend, timer })
          socket.write(encodeFrame(JSON.stringify({ id, method, params })))
        })
      },
      onEvent(listener) {
        listeners.push(listener)

        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) {
            listeners.splice(index, 1)
          }
        }
      },
      close() {
        if (closed) {
          return
        }
        closed = true
        pending.forEach((item) => {
          clearTimeout(item.timer)
          item.reject(new McpError('TIMEOUT', 'CDP 连接已关闭'))
        })
        pending.clear()
        try {
          socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
        } catch {
          // 忽略关闭帧写入失败
        }
        socket.destroy()
      },
    }

    const handleMessage = (raw: string) => {
      let message: any
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }

      if (typeof message.id === 'number') {
        const item = pending.get(message.id)
        if (!item) {
          return
        }
        pending.delete(message.id)
        clearTimeout(item.timer)
        if (message.error) {
          item.reject(
            new McpError(
              'INTERNAL',
              `CDP 错误：${message.error.message || JSON.stringify(message.error)}`
            )
          )
        } else {
          item.resolve(message.result)
        }
        return
      }

      if (message.method) {
        if (events.length < MAX_LOG_EVENTS) {
          events.push(message)
        }
        listeners.slice().forEach((listener) => listener(message))
      }
    }

    const parseFrames = () => {
      while (buffer.length >= 2) {
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2

        if (length === 126) {
          if (buffer.length < 4) {
            return
          }
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) {
            return
          }
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }

        if (masked) {
          offset += 4
        }
        if (buffer.length < offset + length) {
          return
        }

        const maskKey = masked ? buffer.subarray(offset - 4, offset) : null
        let payload = buffer.subarray(offset, offset + length)
        if (maskKey) {
          const unmasked = Buffer.alloc(length)
          for (let i = 0; i < length; i++) {
            unmasked[i] = payload[i] ^ maskKey[i & 3]
          }
          payload = unmasked
        }
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x9) {
          // ping -> 空 pong（FIN + opcode 0xA + mask + 4 字节掩码键）
          socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]))
          continue
        }
        if (opcode === 0x8) {
          session.close()
          return
        }
        if (opcode === 0x0) {
          fragments.push(Buffer.from(payload))
          if (!fin) {
            continue
          }
          const full = Buffer.concat(fragments).toString('utf8')
          fragments = []
          handleMessage(full)
          continue
        }
        if (!fin) {
          fragments = [Buffer.from(payload)]
          continue
        }
        handleMessage(payload.toString('utf8'))
      }
    }

    const key = randomBytes(16).toString('base64')
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname
    const path = `${url.pathname || '/'}${url.search || ''}`

    const timer = setTimeout(() => {
      fail(new McpError('TIMEOUT', `CDP 握手超时：${wsUrl}`))
    }, timeout)

    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
      )
    })

    socket.on('data', (chunk) => {
      if (closed) {
        return
      }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk

      if (!handshaken) {
        const index = buffer.indexOf('\r\n\r\n')
        if (index < 0) {
          return
        }
        const header = buffer.subarray(0, index).toString('latin1')
        buffer = buffer.subarray(index + 4)
        if (!/^HTTP\/1\.1 101/.test(header)) {
          clearTimeout(timer)
          fail(
            new McpError(
              'INTERNAL',
              `CDP 握手失败：${header.split('\r\n')[0] || 'no response'}`
            )
          )
          return
        }
        handshaken = true
        clearTimeout(timer)
        resolve(session)
      }

      parseFrames()
    })

    socket.on('error', (err) => {
      fail(new McpError('DEVICE_OFFLINE', `CDP 连接失败：${err.message}`))
    })

    socket.on('close', () => {
      if (!closed) {
        closed = true
        clearTimeout(timer)
        pending.forEach((item) => {
          clearTimeout(item.timer)
          item.reject(new McpError('DEVICE_OFFLINE', 'CDP 连接被关闭'))
        })
        pending.clear()
        if (!handshaken) {
          reject(new McpError('DEVICE_OFFLINE', 'CDP 连接被关闭'))
        }
      }
    })
  })
}

// WebView 页面的第一帧往往是 about:blank 或 devtools 自身，优先挑真实页面
export function pickPage<T extends { url?: string; type?: string }>(
  pages: T[],
  match?: string
) {
  const usable = pages.filter((page) => page.url && page.type !== 'devtools')
  if (match) {
    const hit = usable.find((page) => (page.url || '').includes(match))
    if (hit) {
      return hit
    }
  }

  const real = usable.find(
    (page) => page.url && !page.url.startsWith('about:') && !page.url.startsWith('chrome')
  )

  return real || usable[0] || pages[0] || null
}

export interface IJsResult {
  value: unknown
  exception: string
  description: string
}

// 把 Runtime.evaluate 的返回统一成 {value, exception, description}
export function normalizeJsResult(result: any): IJsResult {
  if (!result) {
    return { value: undefined, exception: '', description: '' }
  }
  const info = result.result || {}
  return {
    value: info.value,
    exception: result.exceptionDetails
      ? result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'JS 执行异常'
      : '',
    description: info.description || '',
  }
}
