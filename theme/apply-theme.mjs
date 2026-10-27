/**
 * 同步站点样式到两个页面。
 *
 * 用法：
 *   1. 修改 theme/theme.css（公共设计系统 + index 专属段）
 *      与 theme/theme.tools.css（tools 专属段）
 *   2. node theme/apply-theme.mjs
 *
 * 脚本会把 theme.css 的公共段写进 index.html 与 tools.html，
 * 并分别追加各自的 page-specific 段。
 * 页面保持内联样式（单文件部署即可生效，不依赖额外静态资源）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const INDEX = path.join(ROOT, 'page/index.html')
const TOOLS = path.join(ROOT, 'page/tools.html')
const MARK = '/* ===== page-specific: index ===== */'

const theme = fs.readFileSync(path.join(ROOT, 'theme/theme.css'), 'utf8')
const toolsExtra = fs.readFileSync(path.join(ROOT, 'theme/theme.tools.css'), 'utf8')

// 1) index.html：整体替换 style 块
let index = fs.readFileSync(INDEX, 'utf8')
if (!/<style>[\s\S]*?<\/style>/.test(index)) throw new Error('index.html 缺少 style 块')
index = index.replace(/<style>[\s\S]*?<\/style>/, () => `<style>\n${theme}\n    </style>`)
fs.writeFileSync(INDEX, index)

// 2) tools.html：公共段 + tools 专属段
const [base] = theme.split(MARK)
if (base === theme) throw new Error('theme.css 缺少 page-specific 标记')
let tools = fs.readFileSync(TOOLS, 'utf8')
if (!/<style>[\s\S]*?<\/style>/.test(tools)) throw new Error('tools.html 缺少 style 块')
const merged = `${base}/* ===== page-specific: tools ===== */\n${toolsExtra}`
tools = tools.replace(/<style>[\s\S]*?<\/style>/, () => `<style>\n${merged}\n    </style>`)
fs.writeFileSync(TOOLS, tools)

console.log('theme applied | index:', theme.length, 'bytes | tools:', merged.length, 'bytes')
