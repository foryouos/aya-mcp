import { IToolResult } from '../lib/result'

export interface McpTool {
  name: string
  description: string
  inputSchema: object
  write: boolean
  annotations?: object
  timeout?: number
  handler: (args: any) => Promise<IToolResult>
}
