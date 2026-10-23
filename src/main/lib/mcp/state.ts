import { randomBytes } from 'node:crypto'
import { getSettingsStore } from '../store'

const settingsStore = getSettingsStore()

export const DEFAULT_PORT = 7788

export const runtime = {
  running: false,
  rev: 0,
  error: '',
}

export function getPort(): number {
  const port = parseInt(settingsStore.get('mcpPort'), 10)

  return port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
}

export function getToken(): string {
  return settingsStore.get('mcpToken') || ''
}

export function ensureToken(): string {
  let token = getToken()
  if (!token) {
    token = randomBytes(16).toString('hex')
    settingsStore.set('mcpToken', token)
  }

  return token
}

export function resetToken(): string {
  const token = randomBytes(16).toString('hex')
  settingsStore.set('mcpToken', token)

  return token
}

export function isAllowWrite(): boolean {
  return !!settingsStore.get('mcpAllowWrite')
}

export function isEnabled(): boolean {
  return !!settingsStore.get('mcpEnabled')
}

export function isLan(): boolean {
  return !!settingsStore.get('mcpLan')
}
