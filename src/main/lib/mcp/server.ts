import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { handleMessage } from './protocol'
import { getToken } from './state'
import log from 'share/common/log'

const logger = log('mcp')

const MAX_BODY = 2 * 1024 * 1024
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

let server: http.Server | null = null
let servingPort = 0
const events = new Set<http.ServerResponse>()

function isAuthorized(req: http.IncomingMessage) {
  const token = getToken()
  if (!token) {
    return false
  }

  const header = req.headers.authorization || ''
  const expected = `Bearer ${token}`
  if (header.length !== expected.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

function isAllowedOrigin(req: http.IncomingMessage) {
  const origin = req.headers.origin
  if (!origin) {
    return true
  }

  return LOCAL_ORIGIN.test(origin)
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== 'GET') {
    sendText(res, 405, 'Method Not Allowed', { Allow: 'GET' })
    return
  }
  if (!isAuthorized(req)) {
    sendText(res, 401, 'Unauthorized')
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')
  events.add(res)

  const timer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n')
    }
  }, 25000)

  req.on('close', () => {
    clearInterval(timer)
    events.delete(res)
  })
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' })
    return
  }
  if (!isAllowedOrigin(req)) {
    sendText(res, 403, 'Forbidden origin')
    return
  }
  if (!isAuthorized(req)) {
    sendText(res, 401, 'Unauthorized: invalid or missing bearer token')
    return
  }

  const body = await readBody(req).catch((err) => {
    logger.error('read body failed', err.message)
    return ''
  })
  if (!body) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
    return
  }

  const batch = Array.isArray(parsed)
  const messages: any[] = batch ? (parsed as any[]) : [parsed]
  const responses: unknown[] = []

  for (let i = 0; i < messages.length; i++) {
    const response = await handleMessage(messages[i]).catch((err) => ({
      jsonrpc: '2.0',
      id: (messages[i] && messages[i].id) ?? null,
      error: { code: -32603, message: err.message || 'Internal error' },
    }))
    if (response) {
      responses.push(response)
    }
  }

  if (!responses.length) {
    res.writeHead(204)
    res.end()
    return
  }

  const payload = batch ? responses : responses[0]
  const accept = (req.headers.accept || '').toLowerCase()

  if (!accept.includes('application/json') && accept.includes('text/event-stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    return
  }

  sendJson(res, 200, payload)
}

function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')

  if (url.pathname === '/mcp/events') {
    handleEvents(req, res)
    return
  }

  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not Found' })
    return
  }

  handleMcp(req, res).catch((err) => {
    logger.error('request failed', err.message)
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal error' },
      })
    }
  })
}

export function start(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(onRequest)

    const onError = (err: NodeJS.ErrnoException) => {
      srv.close()
      reject(err)
    }

    srv.once('error', onError)
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', onError)
      srv.on('error', (err) => logger.error('server error', err.message))
      server = srv
      servingPort = port
      resolve()
    })
  })
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    events.forEach((res) => {
      if (!res.writableEnded) {
        res.end()
      }
    })
    events.clear()

    if (!server) {
      resolve()
      return
    }

    const srv = server
    server = null
    servingPort = 0

    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }

    srv.close(finish)
    const anySrv = srv as any
    if (typeof anySrv.closeAllConnections === 'function') {
      anySrv.closeAllConnections()
    }
    setTimeout(() => {
      if (!done) {
        if (typeof anySrv.closeAllConnections === 'function') {
          anySrv.closeAllConnections()
        }
        finish()
      }
    }, 800)
  })
}

export function isRunning() {
  return !!server
}

export function getPort() {
  return servingPort
}

export function broadcast(payload: unknown) {
  const data = `data: ${JSON.stringify(payload)}\n\n`

  events.forEach((res) => {
    if (!res.writableEnded) {
      res.write(data)
    }
  })
}

export function getSubscriberCount() {
  return events.size
}
