#!/usr/bin/env node
/**
 * AYA MCP stdio <-> HTTP bridge.
 *
 * Zero dependency. Reads JSON-RPC messages from stdin, forwards them to the
 * AYA main-process MCP endpoint over HTTP, writes responses back to stdout.
 * It also subscribes to /mcp/events (SSE) so that tool list changes made in
 * the AYA UI reach the client as notifications/tools/list_changed.
 *
 * Config priority: --url/--token argv > AYA_MCP_URL/AYA_MCP_TOKEN env > default.
 */
'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- 独立运行的 CJS 单体脚本，不能用 ESM 语法 */

const http = require('node:http')
const readline = require('node:readline')

const DEFAULT_URL = 'http://127.0.0.1:7788/mcp'

function log(msg) {
  process.stderr.write(`[aya-mcp] ${msg}\n`)
}

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const matched = /^--([^=]+)=(.*)$/.exec(arg)
    if (matched) {
      out[matched[1]] = matched[2]
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const endpoint = args.url || process.env.AYA_MCP_URL || DEFAULT_URL
const token = args.token || process.env.AYA_MCP_TOKEN || ''

let target
try {
  target = new URL(endpoint)
} catch (err) {
  log(`invalid endpoint "${endpoint}": ${err.message}`)
  process.exit(1)
}

const eventsTarget = new URL(target.toString())
eventsTarget.pathname = '/mcp/events'
eventsTarget.search = ''

// Separate pools: the SSE stream holds its socket forever, so sharing one
// agent with maxSockets:1 would starve every JSON-RPC request.
const requestAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })
const eventsAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })

function writeLine(text) {
  return new Promise((resolve) => {
    if (process.stdout.write(text + '\n')) {
      resolve()
    } else {
      process.stdout.once('drain', resolve)
    }
  })
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
  }
}

/** POST one JSON-RPC payload; resolves { status, body } or { error }. */
function post(payloadText) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        agent: requestAgent,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-length': Buffer.byteLength(payloadText),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8').trim(),
          })
        })
      }
    )

    req.on('error', (err) => resolve({ error: err.message }))
    req.end(payloadText)
  })
}

function idsOf(parsed) {
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const ids = []
  for (const item of list) {
    if (item && typeof item === 'object' && item.id !== undefined) {
      ids.push(item.id)
    }
  }
  return ids
}

function normalizeResponse(body, ids) {
  try {
    return JSON.stringify(JSON.parse(body))
  } catch {
    log(`non-JSON response from server: ${body.slice(0, 200)}`)
    return ids.length
      ? JSON.stringify(
          errorResponse(ids[0], -32700, 'invalid response from AYA MCP server')
        )
      : ''
  }
}

let queue = Promise.resolve()

function enqueue(task) {
  queue = queue.then(task).catch((err) => log(`queue error: ${err.message}`))
  return queue
}

function handleLine(line) {
  const text = line.trim()
  if (!text) {
    return
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    log('invalid JSON on stdin')
    writeLine(
      JSON.stringify(errorResponse(null, -32700, `parse error: ${err.message}`))
    )
    return
  }

  const ids = idsOf(parsed)

  enqueue(async () => {
    const result = await post(text)

    if (!ids.length) {
      // Notification: JSON-RPC says never answer these.
      if (result.error) {
        log(`notification dropped: ${result.error}`)
      }
      return
    }

    const id = ids[0]

    if (result.error) {
      await writeLine(
        JSON.stringify(
          errorResponse(
            id,
            -32000,
            `AYA MCP server unreachable at ${endpoint} (${result.error}). ` +
              'Make sure AYA is running and the MCP server is enabled.'
          )
        )
      )
      return
    }

    if (result.status === 401 || result.status === 403) {
      await writeLine(
        JSON.stringify(
          errorResponse(
            id,
            -32001,
            'unauthorized: token mismatch, re-copy the config from AYA settings'
          )
        )
      )
      return
    }

    if (!result.body) {
      await writeLine(
        JSON.stringify(
          errorResponse(id, -32603, 'empty response from AYA MCP server')
        )
      )
      return
    }

    await writeLine(normalizeResponse(result.body, ids))
  })
}

function handleEvent(raw) {
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (!dataLines.length) {
    return
  }

  let payload
  try {
    payload = JSON.parse(dataLines.join('\n'))
  } catch {
    return
  }

  // Only forward what MCP clients understand; token/state events are internal.
  if (payload && payload.method === 'notifications/tools/list_changed') {
    enqueue(() => writeLine(JSON.stringify(payload)))
  }
}

const reconnectDelays = [1000, 2000, 5000]

function scheduleReconnect(attempt) {
  const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]
  setTimeout(() => subscribeEvents(attempt + 1), delay)
}

let eventsClosed = false

function subscribeEvents(attempt) {
  if (eventsClosed) {
    return
  }

  const headers = { accept: 'text/event-stream' }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  const req = http.request(
    {
      protocol: eventsTarget.protocol,
      hostname: eventsTarget.hostname,
      port: eventsTarget.port,
      path: eventsTarget.pathname,
      method: 'GET',
      agent: eventsAgent,
      headers,
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        log(`events stream rejected (${res.statusCode}), retrying`)
        scheduleReconnect(attempt)
        return
      }

      res.setEncoding('utf8')
      let buffer = ''

      res.on('data', (chunk) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const raw = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          handleEvent(raw)
          index = buffer.indexOf('\n\n')
        }
      })

      res.on('end', () => {
        log('events stream closed, reconnecting')
        scheduleReconnect(0)
      })
    }
  )

  req.on('error', (err) => {
    log(`events stream error: ${err.message}`)
    scheduleReconnect(attempt)
  })

  req.end()
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})
rl.on('line', handleLine)
rl.on('close', () => {
  eventsClosed = true
  setTimeout(() => process.exit(0), 50)
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

if (!token) {
  log('no token provided, requests will be rejected until one is configured')
}

subscribeEvents(0)
