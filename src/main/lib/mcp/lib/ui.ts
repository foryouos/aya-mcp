import { IUiNode } from './snapshot'

export interface IMatchOptions {
  text?: string
  id?: string
  desc?: string
  clickableOnly?: boolean
  exact?: boolean
}

export function matchValue(value: string, query: string, exact: boolean) {
  if (!value || !query) {
    return false
  }

  return exact
    ? value === query
    : value.toLowerCase().includes(query.toLowerCase())
}

export function findMatches(flat: IUiNode[], opts: IMatchOptions) {
  const exact = opts.exact !== false

  return flat.filter((node) => {
    if (opts.clickableOnly && !node.clickable) {
      return false
    }
    if (opts.text && !matchValue(node.text, opts.text, exact)) {
      return false
    }
    if (opts.id && !matchValue(node.id, opts.id, exact)) {
      return false
    }
    if (opts.desc && !matchValue(node.desc, opts.desc, exact)) {
      return false
    }

    return true
  })
}

export function brief(node: IUiNode) {
  return {
    i: node.i,
    text: node.text,
    desc: node.desc,
    id: node.id,
    class: node.cls,
    clickable: node.clickable,
    bounds: node.bounds,
    center: node.center,
  }
}

function compactNode(
  node: IUiNode,
  maxDepth: number,
  budget: { left: number; truncated: boolean }
): any {
  budget.left--

  const ret: any = {
    i: node.i,
    bounds: node.bounds,
    center: node.center,
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
  if (node.cls) {
    ret.class = node.cls
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
  if (!node.enabled) {
    ret.enabled = false
  }

  if (node.depth < maxDepth && node.children.length) {
    const children: any[] = []
    for (let i = 0; i < node.children.length; i++) {
      if (budget.left <= 0) {
        budget.truncated = true
        break
      }
      children.push(compactNode(node.children[i], maxDepth, budget))
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
  maxNodes: number
) {
  const budget = { left: maxNodes, truncated: false }
  const nodes = [compactNode(root, maxDepth, budget)]

  return {
    nodes,
    count: Math.max(0, maxNodes - budget.left),
    truncated: budget.truncated,
  }
}
