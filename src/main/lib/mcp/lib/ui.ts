import { IUiNode } from './snapshot'

export interface IMatchOptions {
  text?: string
  id?: string
  desc?: string
  clickableOnly?: boolean
  exact?: boolean
  // 只匹配当前可见（未被滚动容器裁掉）的节点，避免拿到屏幕外坐标点空
  visibleOnly?: boolean
}

export function matchValue(value: string, query: string, exact: boolean) {
  if (!value || !query) {
    return false
  }

  return exact
    ? value === query
    : value.toLowerCase().includes(query.toLowerCase())
}

/**
 * resource-id 在设备上始终带包名前缀（com.foo:id/btnLock），而调用方通常只写短名。
 * 精确匹配时必须同时认短名，否则 aya_tap {id:"btnLock"} 会永远 NO_MATCH。
 */
export function matchId(value: string, query: string, exact: boolean) {
  if (!value || !query) {
    return false
  }
  if (matchValue(value, query, exact)) {
    return true
  }
  const slash = value.lastIndexOf('/')
  if (slash < 0) {
    return false
  }
  const short = value.slice(slash + 1)

  return exact
    ? short === query
    : short.toLowerCase().includes(query.toLowerCase())
}

export function findMatches(flat: IUiNode[], opts: IMatchOptions) {
  const exact = opts.exact !== false

  return flat.filter((node) => {
    if (opts.visibleOnly && !node.visible) {
      return false
    }
    if (opts.clickableOnly && !node.clickable) {
      return false
    }
    if (opts.text && !matchValue(node.text, opts.text, exact)) {
      return false
    }
    if (opts.id && !matchId(node.id, opts.id, exact)) {
      return false
    }
    if (opts.desc && !matchValue(node.desc, opts.desc, exact)) {
      return false
    }

    return true
  })
}

export function brief(node: IUiNode) {
  const ret: Record<string, unknown> = {
    i: node.i,
    text: node.text,
    desc: node.desc,
    id: node.id,
    class: node.cls,
    clickable: node.clickable,
    bounds: node.bounds,
    center: node.center,
  }
  if (!node.visible) {
    ret.visible = false
  }

  return ret as any
}

// aya_ui_dump 的 fields 参数：只保留调用方要的字段，进一步压缩返回体积。
// i 永远保留，否则拿不到节点索引；center 在只给 bounds 时仍需要，故一并保留可选。
export function projectNode(
  node: IUiNode,
  fields?: string[] | null
): Record<string, unknown> {
  const base = brief(node)
  if (!fields || !fields.length) {
    return base
  }

  const wanted = new Set(fields.map((field) => field.toLowerCase()))
  const ret: Record<string, unknown> = { i: node.i }
  if (!node.visible) {
    ret.visible = false
  }

  if (wanted.has('text') && node.text) {
    ret.text = node.text
  }
  if (wanted.has('desc') && node.desc) {
    ret.desc = node.desc
  }
  if (wanted.has('id') && node.id) {
    ret.id = node.id
  }
  if (wanted.has('class')) {
    ret.class = node.cls
  }
  if (wanted.has('bounds')) {
    ret.bounds = node.bounds
  }
  if (wanted.has('center') || wanted.has('bounds')) {
    ret.center = node.center
  }
  if (wanted.has('clickable') && node.clickable) {
    ret.clickable = true
  }
  if (wanted.has('flags')) {
    if (node.scrollable) {
      ret.scrollable = true
    }
    if (node.focused) {
      ret.focused = true
    }
    if (node.checked || node.selected) {
      ret.selected = true
    }
    if (!node.enabled) {
      ret.enabled = false
    }
  }

  return ret
}

function shortClass(cls: string) {
  if (!cls) {
    return ''
  }
  const parts = cls.split('.')

  return parts[parts.length - 1]
}

// 动作后回传的节点：只保留能点击/能滚动的实用节点，字段按需出现以压缩体积
export function labelNode(node: IUiNode) {
  const ret: any = {
    i: node.i,
    class: shortClass(node.cls),
    center: node.center,
    bounds: node.bounds,
  }

  if (!node.visible) {
    ret.visible = false
  }

  if (node.text) {
    ret.text = node.text
  }
  if (node.desc) {
    ret.desc = node.desc
  }
  if (node.id) {
    ret.id = node.id
  }
  if (node.clickable) {
    ret.clickable = true
  }
  if (node.scrollable) {
    ret.scrollable = true
  }
  if (node.checked || node.selected) {
    ret.selected = true
  }
  if (node.focused) {
    ret.focused = true
  }
  if (!node.enabled) {
    ret.enabled = false
  }

  return ret
}

function isActionable(node: IUiNode) {
  if (!node.enabled || !node.visible) {
    return false
  }

  return node.clickable || node.scrollable || !!node.text || !!node.desc
}

export function pickActionable(flat: IUiNode[], limit: number) {
  const picked: IUiNode[] = []
  let total = 0

  for (let i = 0; i < flat.length; i++) {
    const node = flat[i]
    if (!isActionable(node)) {
      continue
    }
    total++
    if (picked.length < limit) {
      picked.push(node)
    }
  }

  return {
    nodes: picked.map(labelNode),
    total,
    truncated: total > picked.length,
  }
}

interface ICompactOptions {
  visibleOnly?: boolean
  hidden: { count: number }
  rendered: { count: number }
}

function compactNode(
  node: IUiNode,
  maxDepth: number,
  budget: { left: number; truncated: boolean },
  fields: Set<string> | null,
  options: ICompactOptions
): any {
  // 屏幕外节点（滚动容器里未滚出来的列表项）不占预算：它们只会撑大返回体，
  // 而且坐标点不到。默认关掉，传 visibleOnly:true 即可启用。
  // 根节点始终保留，否则窗口 bounds 异常时会返回空树，看不出界面到底是什么。
  if (options.visibleOnly && !node.visible && node.depth > 0) {
    options.hidden.count++

    return null
  }

  budget.left--
  options.rendered.count++

  // fields 为 null 时保持旧行为（全字段）；否则按需裁剪，i 与 children 始终保留
  const want = (name: string) => !fields || fields.has(name)
  const ret: any = { i: node.i }

  if (!node.visible) {
    ret.visible = false
  }
  if (want('bounds')) {
    ret.bounds = node.bounds
  }
  if (want('center') || want('bounds')) {
    ret.center = node.center
  }
  if (want('text') && node.text) {
    ret.text = node.text
  }
  if (want('desc') && node.desc) {
    ret.desc = node.desc
  }
  if (want('id') && node.id) {
    ret.id = node.id
  }
  if (want('class') && node.cls) {
    ret.class = node.cls
  }
  if (want('clickable') && node.clickable) {
    ret.clickable = true
  }
  if (!fields || want('flags')) {
    if (node.scrollable) {
      ret.scrollable = true
    }
    if (node.checked || node.selected) {
      ret.selected = true
    }
    if (node.focused) {
      ret.focused = true
    }
    if (!node.enabled) {
      ret.enabled = false
    }
  }

  if (node.depth < maxDepth && node.children.length) {
    const children: any[] = []
    for (let i = 0; i < node.children.length; i++) {
      if (budget.left <= 0) {
        budget.truncated = true
        break
      }
      const child = compactNode(
        node.children[i],
        maxDepth,
        budget,
        fields,
        options
      )
      if (child) {
        children.push(child)
      }
    }
    if (children.length) {
      ret.children = children
    }
  }

  return ret
}

export function compactTree(
  root: IUiNode,
  maxDepth: number,
  maxNodes: number,
  fields?: string[] | null,
  options: { visibleOnly?: boolean } = {}
) {
  const budget = { left: maxNodes, truncated: false }
  const wanted =
    fields && fields.length
      ? new Set(fields.map((field) => String(field).toLowerCase()))
      : null
  const counter: ICompactOptions = {
    visibleOnly: options.visibleOnly === true,
    hidden: { count: 0 },
    rendered: { count: 0 },
  }
  const tree = compactNode(root, maxDepth, budget, wanted, counter)

  return {
    nodes: tree ? [tree] : [],
    count: counter.rendered.count,
    hidden: counter.hidden.count,
    truncated: budget.truncated,
  }
}
