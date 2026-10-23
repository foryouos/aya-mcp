import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from 'common/util'

const MAX_HISTORY = 20
const STORAGE_PREFIX = 'aya.logcat.history.'

interface IHistoryInputProps {
  placeholder: string
  value: string
  historyKey: string
  onChange: (val: string) => void
  // 回车提交后触发（失焦不触发），用于串口发送
  onEnter?: (val: string) => void
  // 串口发送需要保留首尾空格，默认仍然 trim
  trimValue?: boolean
}

export function loadHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key)
    if (!raw) {
      return []
    }
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) {
      return []
    }
    const ret: string[] = []
    list.forEach((item) => {
      if (typeof item === 'string' && item && ret.indexOf(item) === -1) {
        ret.push(item)
      }
    })
    return ret.slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

function saveHistory(key: string, list: string[]) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(list))
  } catch {
    // localStorage 不可用时忽略，历史记录降级为不持久化
  }
}

// 外部（如双击日志条目）填入的值也记入历史
export function recordHistory(key: string, value: string) {
  const val = value.trim()
  if (!val) {
    return
  }
  const list = loadHistory(key).filter((item) => item !== val)
  list.unshift(val)
  saveHistory(key, list.slice(0, MAX_HISTORY))
}

export default function HistoryInput(props: IHistoryInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const [history, setHistory] = useState<string[]>(() =>
    loadHistory(props.historyKey)
  )
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})

  useEffect(() => {
    if (active > -1) {
      activeRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [active])

  // 滚动或改变窗口大小后位置失效，直接关闭
  useEffect(() => {
    if (!open) {
      return
    }
    const close = () => setOpen(false)
    window.addEventListener('resize', close)
    // 不用捕获阶段，否则面板自身滚动也会被当成页面滚动而关闭
    window.addEventListener('scroll', close)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close)
    }
  }, [open])

  function openPanel() {
    const input = inputRef.current
    if (!input) {
      return
    }
    const list = loadHistory(props.historyKey)
    if (!list.length) {
      return
    }
    setHistory(list)

    const rect = input.getBoundingClientRect()
    const width = Math.max(rect.width, 180)
    const panelHeight = Math.min(list.length * 26 + 32, 260)
    const spaceBelow = window.innerHeight - rect.bottom
    const top =
      spaceBelow < panelHeight + 8
        ? Math.max(4, rect.top - panelHeight - 2)
        : rect.bottom + 2
    setPanelStyle({
      left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 8)),
      top,
      width,
    })
    setActive(-1)
    setOpen(true)
  }

  function commit(val: string) {
    const text = props.trimValue === false ? val : val.trim()
    if (text) {
      recordHistory(props.historyKey, text)
      setHistory(loadHistory(props.historyKey))
    }
    // 值没变化时不要通知父级，避免无谓地重建整份日志视图
    if (text !== props.value) {
      props.onChange(text)
    }
    setOpen(false)
    setActive(-1)
    return text
  }

  function removeItem(item: string, e: ReactMouseEvent) {
    e.stopPropagation()
    const list = history.filter((val) => val !== item)
    saveHistory(props.historyKey, list)
    setHistory(list)
    setActive(-1)
    if (!list.length) {
      setOpen(false)
    }
  }

  function clearHistory() {
    saveHistory(props.historyKey, [])
    setHistory([])
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const val =
        open && active > -1 && history[active] ? history[active] : props.value
      const text = commit(val)
      props.onEnter?.(text)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openPanel()
        return
      }
      if (!history.length) {
        return
      }
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive((active + delta + history.length) % history.length)
    }
  }

  return (
    <div className="luna-toolbar-item luna-toolbar-item-input logcat-history-input">
      <input
        ref={inputRef}
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={openPanel}
        onClick={openPanel}
        onBlur={() => commit(props.value)}
        onKeyDown={onKeyDown}
      />
      {open &&
        createPortal(
          <div className="logcat-history-panel" style={panelStyle}>
            {history.map((item, i) => (
              <div
                key={item}
                ref={i === active ? activeRef : null}
                className={`logcat-history-item${i === active ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(item)}
              >
                <span className="logcat-history-text" title={item}>
                  {item}
                </span>
                <span
                  className="logcat-history-remove"
                  title={t('delete')}
                  onClick={(e) => removeItem(item, e)}
                >
                  ×
                </span>
              </div>
            ))}
            <div className="logcat-history-footer">
              <span
                className="logcat-history-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={clearHistory}
              >
                {t('clearHistory')}
              </span>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
