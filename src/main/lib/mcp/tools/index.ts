import { isAllowWrite } from '../state'
import { McpTool } from './types'
import deviceTools from './device'
import screenTools from './screen'
import inputTools from './input'
import gestureTools from './gesture'
import appTools from './app'
import shellTools from './shell'
import packageTools from './package'
import performanceTools from './performance'
import fileTools from './file'
import logcatTools from './logcat'
import batchTools from './batch'
import waitTools from './wait'
import portTools from './port'
import webviewTools from './webview'

export type { McpTool } from './types'

const toolGroups: McpTool[][] = [
  deviceTools,
  screenTools,
  inputTools,
  gestureTools,
  batchTools,
  waitTools,
  appTools,
  shellTools,
  packageTools,
  performanceTools,
  fileTools,
  logcatTools,
  portTools,
  webviewTools,
]

export function getAllTools(): McpTool[] {
  const ret: McpTool[] = []

  toolGroups.forEach((group) => {
    group.forEach((tool) => ret.push(tool))
  })

  return ret
}

export function getVisibleTools(): McpTool[] {
  const allowWrite = isAllowWrite()

  return getAllTools().filter((tool) => allowWrite || !tool.write)
}

export function findTool(name: string): McpTool | undefined {
  return getVisibleTools().find((tool) => tool.name === name)
}

export function findAllTools(name: string): McpTool | undefined {
  return getAllTools().find((tool) => tool.name === name)
}

export function getToolSchema(tool: McpTool) {
  // 客户端根据 readOnlyHint 决定是否弹确认框，写工具显式标注更安全
  const annotations = tool.annotations || { readOnlyHint: !tool.write }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations,
  }
}
