export type McpErrorCode =
  | 'NO_DEVICE'
  | 'DEVICE_OFFLINE'
  | 'DUMP_FAILED'
  | 'STALE_SNAPSHOT'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'WRITE_DISABLED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'PORT_IN_USE'
  | 'INVALID_ARGS'
  | 'INTERNAL'

export interface ITextContent {
  type: 'text'
  text: string
}

export interface IImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type ToolContent = ITextContent | IImageContent

export interface IToolResult {
  content: ToolContent[]
  isError?: boolean
}

export class McpError extends Error {
  code: McpErrorCode
  detail?: unknown

  constructor(code: McpErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.detail = detail
  }
}

export function textResult(text: string): IToolResult {
  return { content: [{ type: 'text', text }] }
}

export function jsonResult(data: unknown): IToolResult {
  return textResult(JSON.stringify(data, null, 2))
}

export function imageResult(
  base64: string,
  mimeType: string = 'image/png'
): IToolResult {
  return {
    content: [{ type: 'image', data: base64, mimeType }],
  }
}

export function errorResult(err: unknown): IToolResult {
  const error =
    err instanceof McpError
      ? err
      : new McpError(
          'INTERNAL',
          err instanceof Error ? err.message : String(err)
        )

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.detail === undefined ? {} : { detail: error.detail }),
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  }
}

export function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpError('TIMEOUT', `${label} 超时（${ms}ms）`))
    }, ms)

    task.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
