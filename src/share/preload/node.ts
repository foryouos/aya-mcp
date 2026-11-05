import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'

/**
 * contextBridge 只能暴露可序列化 / 可代理的东西，不能直接把 net.Server
 * 和 net.Socket 交给渲染进程，所以这里手写一层壳。
 *
 * 注意：这层壳必须和渲染进程实际用到的 API 完全对齐。
 * 少了 off / destroy / isDestroyed，调用方要么抛 TypeError，
 * 要么像 destroy() 那样被 try/catch 静默吞掉，socket 永远关不掉。
 */
export interface ISocketLike {
  on(event: string, handler: (...args: any[]) => void): void
  off(event: string, handler: (...args: any[]) => void): void
  write(buffer: Uint8Array | string, cb?: (err?: Error | null) => void): boolean
  end(): void
  destroy(): void
  isDestroyed(): boolean
  isWritableEnded(): boolean
}

export interface IServerLike {
  listen(port: number): void
  close(): void
  on(event: string, handler: (...args: any[]) => void): void
  off(event: string, handler: (...args: any[]) => void): void
}

export default {
  createServer: function (listener: (socket: ISocketLike) => void): IServerLike {
    const server = net.createServer((socket) => {
      listener({
        on(event: string, handler: (...args: any[]) => void) {
          socket.on(event, handler)
        },
        off(event: string, handler: (...args: any[]) => void) {
          socket.off(event, handler)
        },
        write(buffer: Uint8Array | string, cb?: (err?: Error | null) => void) {
          return socket.write(buffer, cb)
        },
        end() {
          socket.end()
        },
        destroy() {
          socket.destroy()
        },
        isDestroyed() {
          return socket.destroyed
        },
        isWritableEnded() {
          return socket.writableEnded
        },
      })
    })

    return {
      listen(port: number) {
        server.listen(port)
      },
      close() {
        server.close()
      },
      on(event: string, handler: (...args: any[]) => void) {
        server.on(event, handler)
      },
      off(event: string, handler: (...args: any[]) => void) {
        server.off(event, handler)
      },
    }
  },
  writeFile: fs.promises.writeFile,
  readFile: fs.promises.readFile,
  existsSync: fs.existsSync,
  isDir: async function (file: string): Promise<boolean> {
    const stats = await fs.promises.stat(file)
    return stats.isDirectory()
  },
  isEmptyDir: async function (dir: string): Promise<boolean> {
    const files = await fs.promises.readdir(dir)
    return files.length === 0
  },
  mkdir: fs.promises.mkdir,
  rmdir: fs.promises.rmdir,
  tmpdir: () => {
    return os.tmpdir()
  },
}
