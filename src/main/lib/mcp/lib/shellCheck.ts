import { McpError } from './result'

const ERROR_PATTERNS = [
  /^error:/i,
  /^error\b/i,
  /exception/i,
  /permission denied/i,
  /no such file or directory/i,
  /unknown (option|command|keycode)/i,
  /^usage:/i,
  /segmentation fault/i,
  /could not/i,
  /failed/i,
]

export function detectShellError(output: string): string {
  if (!output) {
    return ''
  }

  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) {
      continue
    }
    if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.slice(0, 300)
    }
  }

  return ''
}

export function assertShellOk(output: string, label: string) {
  const error = detectShellError(output)
  if (error) {
    throw new McpError('INTERNAL', `${label} 执行失败：${error}`)
  }
}
