import { observer } from 'mobx-react-lite'
import LunaToolbar, {
  LunaToolbarInput,
  LunaToolbarSelect,
  LunaToolbarSeparator,
  LunaToolbarSpace,
} from 'luna-toolbar/react'
import LunaLogcat from 'luna-logcat/react'
import Logcat from 'luna-logcat'
import map from 'licia/map'
import rpad from 'licia/rpad'
import dateFormat from 'licia/dateFormat'
import toNum from 'licia/toNum'
import trim from 'licia/trim'
import { useEffect, useRef, useState } from 'react'
import store from '../../store'
import copy from 'licia/copy'
import download from 'licia/download'
import toStr from 'licia/toStr'
import { t } from 'common/util'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import contextMenu from 'share/renderer/lib/contextMenu'

export default observer(function Logcat() {
  const [view, setView] = useState<'compact' | 'standard'>('standard')
  const [softWrap, setSoftWrap] = useState(false)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<{
    priority?: number
    package?: string
    tag?: string
  }>({})
  const [search, setSearch] = useState('')
  const logcatRef = useRef<Logcat>(null)
  const entriesRef = useRef<any[]>([])
  const logcatIdRef = useRef('')
  const searchRef = useRef('')
  const searchTimerRef = useRef<any>(null)

  searchRef.current = search

  function matchSearch(entry: any) {
    const keyword = searchRef.current.trim().toLowerCase()
    if (!keyword) {
      return true
    }
    return (
      entry.message.toLowerCase().indexOf(keyword) > -1 ||
      entry.tag.toLowerCase().indexOf(keyword) > -1 ||
      entry.package.toLowerCase().indexOf(keyword) > -1
    )
  }

  function appendEntry(logcat: any, entry: any) {
    logcat.append(entry)
    decorateEntry(logcat)
  }

  // 包名/标签加全名 tooltip（列宽不足被省略号截断时仍可查看），并处理搜索高亮
  function decorateEntry(logcat: any) {
    const entries = logcat.entries
    const internal = entries[entries.length - 1]
    const container = internal && internal.container
    if (!container) {
      return
    }
    const fields = container.querySelectorAll<HTMLElement>(
      '.luna-logcat-package, .luna-logcat-tag'
    )
    fields.forEach((el) => {
      el.title = (el.textContent || '').trim()
    })
    highlightEntry(container)
  }

  // 搜索时高亮命中的消息/标签/包名文本
  function highlightEntry(container: HTMLElement) {
    const keyword = searchRef.current.trim().toLowerCase()
    if (!keyword) {
      return
    }
    const fields = container.querySelectorAll<HTMLElement>(
      '.luna-logcat-message, .luna-logcat-tag, .luna-logcat-package'
    )
    fields.forEach((el) => {
      const text = el.textContent || ''
      if (text.toLowerCase().indexOf(keyword) > -1) {
        el.innerHTML = highlightText(text, keyword)
      }
    })
  }

  // luna-logcat 自带 filter 不含关键字搜索，搜索变化时重建视图
  useEffect(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    searchTimerRef.current = setTimeout(() => {
      const logcat = logcatRef.current
      if (!logcat) {
        return
      }
      logcat.clear()
      entriesRef.current.forEach((entry) => {
        if (matchSearch(entry)) {
          appendEntry(logcat, entry)
        }
      })
    }, 200)
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
    }
  }, [search])

  const { device } = store

  useEffect(() => {
    function onLogcatEntry(id, entry) {
      if (logcatIdRef.current !== id) {
        return
      }
      entriesRef.current.push(entry)
      if (logcatRef.current && matchSearch(entry)) {
        appendEntry(logcatRef.current, entry)
      }
    }
    const offLogcatEntry = main.on('logcatEntry', onLogcatEntry)
    if (device) {
      main.openLogcat(device.id).then((id) => {
        logcatIdRef.current = id
      })
    }

    return () => {
      offLogcatEntry()
      if (logcatIdRef.current) {
        main.closeLogcat(logcatIdRef.current)
      }
    }
  }, [])

  // 双击日志条目的包名/标签/级别，自动填到上方过滤条件
  // 用捕获阶段 + closest，避免 luna-logcat 重新渲染条目导致 target 失效
  useEffect(() => {
    function onEntryDblClick(e: MouseEvent) {
      const logcat = logcatRef.current
      const target = e.target as HTMLElement | null
      if (!logcat || !target || !target.closest) {
        return
      }
      if (!logcat.container.contains(target)) {
        return
      }
      const el = target.closest(
        '.luna-logcat-package, .luna-logcat-tag, .luna-logcat-priority'
      ) as HTMLElement | null
      if (!el) {
        return
      }
      const text = (el.textContent || '').trim()
      if (!text) {
        return
      }
      if (el.classList.contains('luna-logcat-package')) {
        setFilter((f) => ({ ...f, package: text }))
      } else if (el.classList.contains('luna-logcat-tag')) {
        setFilter((f) => ({ ...f, tag: text }))
      } else {
        const priority = PRIORITY_LETTERS.indexOf(text)
        if (priority >= 2) {
          setFilter((f) => ({ ...f, priority }))
        }
      }
    }
    document.addEventListener('dblclick', onEntryDblClick, true)
    return () => document.removeEventListener('dblclick', onEntryDblClick, true)
  }, [])

  // 切换过滤条件或视图时 luna-logcat 会重绘条目，重绘后补回全名 tooltip
  useEffect(() => {
    const logcat = logcatRef.current
    if (!logcat) {
      return
    }
    logcat.entries.forEach((entry: any) => {
      const container = entry.container
      if (!container) {
        return
      }
      container
        .querySelectorAll<HTMLElement>('.luna-logcat-package, .luna-logcat-tag')
        .forEach((el) => {
          el.title = (el.textContent || '').trim()
        })
    })
  }, [filter, view])

  if (store.panel !== 'logcat') {
    if (!paused && logcatIdRef.current) {
      main.pauseLogcat(logcatIdRef.current)
    }
  } else {
    if (!paused && logcatIdRef.current) {
      main.resumeLogcat(logcatIdRef.current)
    }
  }

  function save() {
    const data = map(entriesRef.current, (entry) => {
      return trim(
        `${dateFormat(entry.date, 'mm-dd HH:MM:ss.l')} ${rpad(
          entry.pid,
          5,
          ' '
        )} ${rpad(entry.tid, 5, ' ')} ${toLetter(entry.priority)} ${
          entry.tag
        }: ${entry.message}`
      )
    }).join('\n')
    const name = `${store.device ? store.device.name : 'logcat'}.${dateFormat(
      'yyyymmddHH'
    )}.txt`

    download(data, name, 'text/plain')
  }

  function clear() {
    if (logcatRef.current) {
      logcatRef.current.clear()
    }
    entriesRef.current = []
  }

  const onContextMenu = (e: PointerEvent, entry: any) => {
    e.preventDefault()
    const logcat = logcatRef.current!
    const template: any[] = [
      {
        label: t('copy'),
        click: () => {
          if (logcat.hasSelection()) {
            copy(logcat.getSelection())
          } else if (entry) {
            copy(entry.message)
          }
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('clear'),
        click: clear,
      },
    ]

    contextMenu(e, template)
  }

  return (
    <div className="panel-with-toolbar">
      <LunaToolbar
        className="panel-toolbar"
        onChange={(key, val) => {
          switch (key) {
            case 'view':
              setView(val)
              break
            case 'priority':
              setFilter({
                ...filter,
                priority: toNum(val),
              })
              break
            case 'package':
              setFilter({
                ...filter,
                package: val,
              })
              break
            case 'tag':
              setFilter({
                ...filter,
                tag: val,
              })
              break
            case 'search':
              setSearch(val)
              break
          }
        }}
      >
        <LunaToolbarSelect
          keyName="view"
          disabled={!device}
          value={view}
          options={{
            [t('standardView')]: 'standard',
            [t('compactView')]: 'compact',
          }}
        />
        <LunaToolbarSeparator />
        <LunaToolbarSelect
          keyName="priority"
          disabled={!device}
          value={toStr(filter.priority || 2)}
          options={{
            VERBOSE: '2',
            DEBUG: '3',
            INFO: '4',
            WARNING: '5',
            ERROR: '6',
          }}
        />
        <LunaToolbarInput
          keyName="tag"
          placeholder={t('tag')}
          value={filter.tag || ''}
        />
        <LunaToolbarInput
          keyName="package"
          placeholder={t('package')}
          value={filter.package || ''}
        />
        <LunaToolbarInput
          keyName="search"
          placeholder={t('search')}
          value={search}
        />
        <LunaToolbarSpace />
        <ToolbarIcon
          icon="save"
          title={t('save')}
          onClick={save}
          disabled={!device}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="soft-wrap"
          state={softWrap ? 'hover' : ''}
          title={t('softWrap')}
          onClick={() => setSoftWrap(!softWrap)}
        />
        <ToolbarIcon
          icon="scroll-end"
          title={t('scrollToEnd')}
          onClick={() => logcatRef.current?.scrollToEnd()}
          disabled={!device}
        />
        <ToolbarIcon
          icon="reset"
          title={t('restart')}
          onClick={() => {
            if (logcatIdRef.current) {
              main.closeLogcat(logcatIdRef.current)
              clear()
            }
            if (device) {
              main.openLogcat(device.id).then((id) => {
                logcatIdRef.current = id
              })
            }
          }}
          disabled={!device}
        />
        <ToolbarIcon
          icon={paused ? 'play' : 'pause'}
          title={t(paused ? 'resume' : 'pause')}
          onClick={() => {
            if (paused) {
              main.resumeLogcat(logcatIdRef.current)
            } else {
              main.pauseLogcat(logcatIdRef.current)
            }
            setPaused(!paused)
          }}
          disabled={!device}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="delete"
          title={t('clear')}
          onClick={clear}
          disabled={!device}
        />
      </LunaToolbar>
      <LunaLogcat
        className="panel-body"
        maxNum={10000}
        filter={filter}
        wrapLongLines={softWrap}
        onContextMenu={onContextMenu}
        view={view}
        onCreate={(logcat) => {
          logcatRef.current = logcat
        }}
      />
    </div>
  )
})

const PRIORITY_LETTERS = ['?', '?', 'V', 'D', 'I', 'W', 'E']

function toLetter(priority: number) {
  return PRIORITY_LETTERS[priority]
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightText(text: string, keyword: string) {
  const lower = text.toLowerCase()
  let html = ''
  let i = 0
  for (;;) {
    const idx = lower.indexOf(keyword, i)
    if (idx === -1) {
      html += escapeHtml(text.slice(i))
      break
    }
    html += escapeHtml(text.slice(i, idx))
    html += `<mark class="logcat-highlight">${escapeHtml(
      text.slice(idx, idx + keyword.length)
    )}</mark>`
    i = idx + keyword.length
  }
  return html
}
