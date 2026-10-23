import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'

export default {
  createServer: function (listener: (socket: net.Socket) => void): net.Server {
    const server = net.createServer((socket) => {
      listener({
        on(event: string, listener: (...args: any[]) => void) {
          socket.on(event, listener)
        },
        write(buffer: Uint8Array | string, cb?: (err?: Error | null) => void) {
          return socket.write(buffer, cb)
        },
      } as any)
    })

    return {
      listen(port: number) {
        server.listen(port)
      },
      close() {
        server.close()
      },
    } as any
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
