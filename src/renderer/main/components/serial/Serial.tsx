import { observer } from 'mobx-react-lite'
import LunaToolbar, {
  LunaToolbarSelect,
  LunaToolbarSeparator,
  LunaToolbarSpace,
  LunaToolbarText,
} from 'luna-toolbar/react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ISerialData,
  ISerialLine,
  ISerialPortInfo,
  ISerialStatus,
  SerialSource,
} from 'common/types'
import dateFormat from 'licia/dateFormat'
import copy from 'licia/copy'
import escapeRegExp from 'licia/escapeRegExp'
import toNum from 'licia/toNum'
import toStr from 'licia/toStr'
import { t } from 'common/util'
import { notify } from 'share/renderer/lib/util'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import contextMenu from 'share/renderer/lib/contextMenu'
import HistoryInput from '../logcat/HistoryInput'
import store from '../../store'
import Style from './Serial.module.scss'

const MAX_LOCAL_LINES = 30000
const TRIM_STEP = 2000
const ROW_HEIGHT = 18
const OVERSCAN = 12

// 主板调试口常用波特率，只保留最常见的三个
const BAUD_RATES = ['115200', '921600', '1500000']

const SOURCE_LABELS: Record<SerialSource, string> = {
  bootloader: 'serialBootloader',
  kernel: 'serialKernel',
  android: 'serialAndroid',
  other: 'serialOther',
}

function buildMatcher(keyword: string, regex: boolean): RegExp | null {
  const val = keyword.trim()
  if (!val) {
    return null
  }
  try {
    return new RegExp(regex ? val : escapeRegExp(val), 'i')
  } catch {
    // 正则非法时退化为普通文本匹配，避免整个视图空白
    try {
      return new RegExp(escapeRegExp(val), 'i')
    } catch {
      return null
    }
  }
}

function renderHighlight(text: string, matcher: RegExp | null) {
  if (!matcher) {
    return text
  }
  const re = new RegExp(matcher.source, 'gi')
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }
    nodes.push(
      <mark key={key++} className={Style.highlight}>
        {match[0]}
      </mark>
    )
    last = match.index + match[0].length
    if (!match[0].length) {
      re.lastIndex++
    }
  }
  if (last < text.length) {
    nodes.push(text.slice(last))
  }
  return nodes
}

export default observer(function Serial() {
  const { settings } = store
  // 必须在 render 中读取，observer 才能追踪面板切换
  const panel = store.panel
  const [ports, setPorts] = useState<ISerialPortInfo[]>([])
  const [status, setStatus] = useState<ISerialStatus | null>(null)
  const [portPath, setPortPath] = useState(settings.serialPath || '')
  const [baudRate, setBaudRate] = useState<number>(
    toNum(settings.serialBaudRate) || 115200
  )
  const [source, setSource] = useState<SerialSource | 'all'>('all')
  const [search, setSearch] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [sendText, setSendText] = useState('')
  const [newline, setNewline] = useState<'crlf' | 'lf' | 'none'>(() => {
    const saved = localStorage.getItem('aya.serial.newline')
    return saved === 'lf' || saved === 'none' ? saved : 'crlf'
  })
  const [detecting, setDetecting] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [version, setVersion] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [maxLength, setMaxLength] = useState(0)

  const linesRef = useRef<ISerialLine[]>([])
  const filteredRef = useRef<ISerialLine[]>([])
  const filterRef = useRef({ search: '', useRegex: false, source: 'all' as string })
  const atBottomRef = useRef(true)
  const manualPauseRef = useRef(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const charWidthRef = useRef(7.2)
  const syncTokenRef = useRef(0)
  const searchTokenRef = useRef(0)
  const statusRef = useRef<ISerialStatus | null>(null)
  statusRef.current = status

  const matcher = useMemo(
    () => buildMatcher(search, useRegex),
    [search, useRegex]
  )

  function isFilterActive() {
    const f = filterRef.current
    return !!f.search.trim() || f.source !== 'all'
  }

  function lineMatch(line: ISerialLine, re: RegExp | null, src: string) {
    if (src !== 'all' && line.source !== src) {
      return false
    }
    return !re || re.test(line.text)
  }

  function setLines(list: ISerialLine[]) {
    linesRef.current = list
    let max = 0
    for (const line of list) {
      if (line.text.length > max) {
        max = line.text.length
      }
    }
    setMaxLength(max)
    rebuildFiltered()
    setVersion((v) => v + 1)
  }

  function rebuildFiltered() {
    const f = filterRef.current
    if (!f.search.trim() && f.source === 'all') {
      filteredRef.current = linesRef.current
      return
    }
    const re = buildMatcher(f.search, f.useRegex)
    filteredRef.current = linesRef.current.filter((line) =>
      lineMatch(line, re, f.source)
    )
  }

  // 过滤在本地做即时响应；有过滤条件时再向主进程查询完整缓冲区（200k 行），
  // 这样搜索能覆盖比本地保留量更早的日志
  async function applyFilter() {
    const f = filterRef.current
    const token = ++searchTokenRef.current
    if (!f.search.trim() && f.source === 'all') {
      filteredRef.current = linesRef.current
      setVersion((v) => v + 1)
      atBottomRef.current = true
      setAutoScroll(true)
      return
    }

    try {
      const res = await main.serialQuery({
        keyword: f.search,
        regex: f.useRegex,
        source: f.source as any,
        lines: 5000,
      })
      if (token !== searchTokenRef.current) {
        return
      }
      filteredRef.current = res.lines
    } catch {
      if (token !== searchTokenRef.current) {
        return
      }
      rebuildFiltered()
    }

    setVersion((v) => v + 1)
    setScrollTop(0)
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0
    }
    atBottomRef.current = false
    setAutoScroll(false)
  }

  function appendLines(incoming: ISerialLine[]) {
    if (!incoming.length) {
      return
    }
    const lines = linesRef.current
    const f = filterRef.current
    const active = isFilterActive()
    const re = active ? buildMatcher(f.search, f.useRegex) : null
    let max = maxLength

    for (const line of incoming) {
      lines.push(line)
      if (line.text.length > max) {
        max = line.text.length
      }
      if (active && lineMatch(line, re, f.source)) {
        filteredRef.current.push(line)
      }
    }

    if (max !== maxLength) {
      setMaxLength(max)
    }

    if (lines.length > MAX_LOCAL_LINES + TRIM_STEP) {
      // 就地裁剪，保证无过滤时 filtered 与 lines 仍是同一个数组
      const remove = lines.length - MAX_LOCAL_LINES
      lines.splice(0, remove)
      // 过滤结果可能包含主进程缓冲里更早的行，这里只限制总量，不按 seq 裁剪
      if (
        filteredRef.current !== lines &&
        filteredRef.current.length > MAX_LOCAL_LINES
      ) {
        filteredRef.current.splice(
          0,
          filteredRef.current.length - MAX_LOCAL_LINES
        )
      }
    }

    setVersion((v) => v + 1)
  }

  function refreshPorts() {
    main.serialListPorts().then((list) => {
      setPorts(list)
      const saved = settings.serialPath
      setPortPath((current) => {
        const exist = list.some((port) => port.path === current)
        if (exist) {
          return current
        }
        const next = saved && list.some((port) => port.path === saved)
          ? saved
          : list[0]?.path || ''
        return next
      })
    })
  }

  async function syncRecent() {
    const token = ++syncTokenRef.current
    try {
      const res = await main.serialQuery({ lines: MAX_LOCAL_LINES })
      if (token !== syncTokenRef.current) {
        return
      }
      setStatus(res.status)
      setLines(res.lines)
      if (isFilterActive()) {
        // 保持搜索条件时重新从主进程完整缓冲取匹配结果
        applyFilter()
        return
      }
      atBottomRef.current = true
      setAutoScroll(true)
    } catch {
      // 主进程未就绪时忽略
    }
  }

  useEffect(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = '12px Consolas, "Courier New", monospace'
      charWidthRef.current = ctx.measureText('0').width || 7.2
    }

    let alive = true
    const offData = main.on('serialData', (payload: ISerialData) => {
      if (!alive || store.panel !== 'serial') {
        return
      }
      const current = statusRef.current
      if (current && payload.sessionId && current.sessionId !== payload.sessionId) {
        return
      }
      appendLines(payload.lines)
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              dropped: payload.dropped,
              bytes: payload.bytes,
              logFileSize: payload.logFileSize,
              lines: prev.lines + payload.lines.length,
            }
          : prev
      )
    })
    const offStatus = main.on('serialStatus', (next: ISerialStatus) => {
      if (!alive) {
        return
      }
      setStatus(next)
    })

    refreshPorts()
    syncRecent()

    const viewport = viewportRef.current
    let observer: ResizeObserver | null = null
    if (viewport) {
      setViewportHeight(viewport.clientHeight)
      setViewportWidth(viewport.clientWidth)
      observer = new ResizeObserver(() => {
        setViewportHeight(viewport.clientHeight)
        setViewportWidth(viewport.clientWidth)
      })
      observer.observe(viewport)
    }

    return () => {
      alive = false
      offData()
      offStatus()
      observer?.disconnect()
    }
  }, [])

  // 设置项是异步从主进程读回的，加载完成后同步到本地，避免用默认 115200 连接主板调试口
  const settingsBaud = toNum(settings.serialBaudRate) || 115200
  useEffect(() => {
    setBaudRate(settingsBaud)
  }, [settingsBaud])

  useEffect(() => {
    if (
      settings.serialPath &&
      ports.some((item) => item.path === settings.serialPath)
    ) {
      setPortPath(settings.serialPath)
    }
  }, [settings.serialPath, ports.length])

  useEffect(() => {
    filterRef.current = { search, useRegex, source }
    const timer = setTimeout(() => {
      applyFilter()
    }, 200)
    return () => clearTimeout(timer)
  }, [search, useRegex, source])

  // 面板隐藏时暂停推送，避免后台日志持续占用渲染进程；主进程仍会继续落盘
  useEffect(() => {
    const visible = panel === 'serial'
    if (visible) {
      if (!manualPauseRef.current) {
        main.serialSetPaused(false)
        syncRecent()
      }
    } else if (!manualPauseRef.current) {
      main.serialSetPaused(true)
    }
  }, [panel])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !autoScroll) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
    setScrollTop(viewport.scrollTop)
  }, [version, autoScroll])

  const filtered = filteredRef.current
  const total = linesRef.current.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const end = Math.min(filtered.length, start + visibleCount)
  const visible = filtered.slice(start, end)
  const contentWidth = Math.max(
    viewportWidth,
    Math.min(maxLength, 8192) * charWidthRef.current + 140
  )

  async function connect() {
    if (status?.open) {
      try {
        await main.serialClose()
      } catch (err) {
        notify((err as Error).message)
      }
      return
    }
    if (!portPath) {
      return
    }
    try {
      await settings.set('serialPath', portPath)
      await settings.set('serialBaudRate', baudRate)
      const next = await main.serialOpen(portPath, baudRate)
      setStatus(next)
      // 新会话会清空主进程缓冲，这里同步清掉旧视图
      await syncRecent()
    } catch (err) {
      notify(`${t('serialConnectFailed')}: ${(err as Error).message}`)
    }
  }

  function togglePause() {
    const next = !status?.paused
    manualPauseRef.current = next
    main.serialSetPaused(next)
    if (!next) {
      syncRecent()
    }
  }

  async function save(mode: 'view' | 'session') {
    try {
      const filePath = await main.serialSave(
        mode,
        mode === 'view' ? { keyword: search, regex: useRegex, source } : {}
      )
      if (filePath) {
        notify(t('serialSaved', { path: filePath }))
      }
    } catch (err) {
      notify(`${t('serialSaveFailed')}: ${(err as Error).message}`)
    }
  }

  function clear() {
    main.serialClear().then((next) => {
      setStatus(next)
      linesRef.current = []
      filteredRef.current = []
      setMaxLength(0)
      setVersion((v) => v + 1)
      atBottomRef.current = true
      setAutoScroll(true)
    })
  }

  // 保留原始内容（首尾空格可能是协议的一部分），不做 trim
  async function send() {
    const data = sendText
    if (!data.length || !status?.open) {
      return
    }
    try {
      await main.serialWrite(data, newline)
      setSendText('')
    } catch (err) {
      notify((err as Error).message)
    }
  }

  function changeNewline(val: 'crlf' | 'lf' | 'none') {
    setNewline(val)
    localStorage.setItem('aya.serial.newline', val)
  }

  // 依次尝试常见波特率，选可读字符最多的一个，专治主板调试口乱码
  async function detectBaud() {
    if (!status?.open || detecting) {
      return
    }
    setDetecting(true)
    notify(t('serialBaudDetecting'))
    try {
      const res = await main.serialDetectBaud()
      setBaudRate(res.rate)
      setStatus(await main.serialStatus())
      if (res.detected) {
        await settings.set('serialBaudRate', res.rate)
        notify(t('serialBaudDetected', { rate: String(res.rate) }))
      } else {
        notify(t('serialBaudNotDetected'))
      }
    } catch (err) {
      notify(`${t('serialBaudDetectFailed')}: ${(err as Error).message}`)
    } finally {
      setDetecting(false)
    }
  }

  function onContextMenu(e: React.MouseEvent, line?: ISerialLine) {
    e.preventDefault()
    const template: any[] = [
      {
        label: t('copy'),
        click: () => {
          const selection = window.getSelection()?.toString()
          if (selection) {
            copy(selection)
          } else if (line) {
            copy(line.text)
          }
        },
      },
      {
        label: t('serialCopyAll'),
        click: () => {
          copy(filteredRef.current.map((item) => item.text).join('\n'))
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('save'),
        click: () => save('view'),
      },
      {
        label: t('serialSaveSession'),
        click: () => save('session'),
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

  const portOptions: Record<string, string> = {}
  ports.forEach((port) => {
    const label = port.friendlyName
      ? `${port.path} (${port.friendlyName})`
      : port.manufacturer
      ? `${port.path} (${port.manufacturer})`
      : port.path
    portOptions[label] = port.path
  })

  const baudOptions: Record<string, string> = {}
  BAUD_RATES.forEach((rate) => {
    baudOptions[rate] = rate
  })
  if (baudRate && !baudOptions[toStr(baudRate)]) {
    baudOptions[toStr(baudRate)] = toStr(baudRate)
  }

  const filterActive = !!search.trim() || source !== 'all'
  let emptyTip = ''
  if (status?.open) {
    if (!total) {
      emptyTip = t('serialWaiting')
    } else if (filterActive && !filtered.length) {
      emptyTip = t('serialNoMatch')
    }
  } else if (!total) {
    emptyTip = ports.length ? t('serialNotConnected') : t('serialNoPort')
  }

  return (
    <div className="panel-with-toolbar">
      <LunaToolbar
        className="panel-toolbar"
        onChange={(key, val) => {
          switch (key) {
            case 'port':
              setPortPath(val)
              settings.set('serialPath', val)
              break
            case 'baud': {
              const rate = toNum(val) || 115200
              setBaudRate(rate)
              settings.set('serialBaudRate', rate)
              // 已连接时直接在线切换，不用断开重连
              if (status?.open && rate !== status.baudRate) {
                main
                  .serialSetBaud(rate)
                  .then(setStatus)
                  .catch((err) => {
                    notify((err as Error).message)
                    setBaudRate(status.baudRate)
                    settings.set('serialBaudRate', status.baudRate)
                  })
              }
              break
            }
            case 'source':
              setSource(val)
              break
          }
        }}
      >
        <LunaToolbarSelect
          keyName="port"
          value={portPath}
          title={t('serialPort')}
          options={portOptions}
          disabled={!!status?.open || detecting}
        />
        <ToolbarIcon
          icon="refresh"
          title={t('refresh')}
          onClick={refreshPorts}
          disabled={!!status?.open || detecting}
        />
        <LunaToolbarSelect
          keyName="baud"
          value={toStr(baudRate)}
          title={t('serialBaudRate')}
          options={baudOptions}
          disabled={detecting}
        />
        <ToolbarIcon
          icon="power"
          state={status?.open ? 'hover' : ''}
          title={t(status?.open ? 'disconnect' : 'connect')}
          onClick={connect}
          disabled={!portPath || detecting}
        />
        <ToolbarIcon
          icon="terminal"
          title={detecting ? t('serialBaudDetecting') : t('serialAutoBaud')}
          onClick={detectBaud}
          disabled={!status?.open || detecting}
        />
        <LunaToolbarSeparator />
        <LunaToolbarSelect
          keyName="source"
          value={source}
          options={{
            [t('serialAllSources')]: 'all',
            [t('serialBootloader')]: 'bootloader',
            [t('serialKernel')]: 'kernel',
            [t('serialAndroid')]: 'android',
            [t('serialOther')]: 'other',
          }}
        />
        <HistoryInput
          placeholder={t('search')}
          value={search}
          historyKey="serial-search"
          onChange={setSearch}
        />
        <ToolbarIcon
          icon="text"
          state={useRegex ? 'hover' : ''}
          title={t('serialRegex')}
          onClick={() => setUseRegex(!useRegex)}
        />
        <LunaToolbarText
          text={`${filtered.length}/${total}${
            status?.paused ? ` ${t('serialPaused')}` : ''
          }`}
        />
        <LunaToolbarSpace />
        <ToolbarIcon
          icon="save"
          title={t('save')}
          onClick={() => save('view')}
          disabled={!status?.sessionId}
        />
        <ToolbarIcon
          icon="storage"
          title={t('serialSaveSession')}
          onClick={() => save('session')}
          disabled={!status?.logFiles?.length}
        />
        <ToolbarIcon
          icon="scroll-end"
          title={t('scrollToEnd')}
          onClick={() => {
            const viewport = viewportRef.current
            if (viewport) {
              viewport.scrollTop = viewport.scrollHeight
              setScrollTop(viewport.scrollTop)
            }
            atBottomRef.current = true
            setAutoScroll(true)
          }}
          disabled={!total}
        />
        <ToolbarIcon
          icon={status?.paused ? 'play' : 'pause'}
          title={t(status?.paused ? 'resume' : 'pause')}
          onClick={togglePause}
          disabled={!status?.sessionId}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="delete"
          title={t('clear')}
          onClick={clear}
          disabled={!total}
        />
      </LunaToolbar>
      <div className={Style.body}>
        <div
          ref={viewportRef}
          className={Style.viewport}
        onScroll={(e) => {
          const el = e.currentTarget
          setScrollTop(el.scrollTop)
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2
          atBottomRef.current = atBottom
          if (atBottom !== autoScroll) {
            setAutoScroll(atBottom)
          }
        }}
        onContextMenu={(e) => onContextMenu(e)}
      >
        {total > 0 && (
          <div
            className={Style.content}
            style={{
              height: filtered.length * ROW_HEIGHT,
              width: contentWidth,
            }}
          >
            {visible.map((line, index) => {
              const absIndex = start + index
              // 阶段切换处画一条分隔线，让 loader 到 kernel 的衔接一目了然
              const stageStart =
                absIndex > 0 &&
                filtered[absIndex - 1]?.source !== line.source
              return (
                <div
                  key={line.seq}
                  className={[
                    Style.row,
                    Style[`row_${line.source}`],
                    stageStart ? Style.stageStart : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ top: (start + index) * ROW_HEIGHT }}
                >
                  <span className={Style.time}>
                    {dateFormat(new Date(line.time), 'HH:MM:ss.l')}
                  </span>
                  <span className={`${Style.badge} ${Style[line.source]}`}>
                    {t(SOURCE_LABELS[line.source])}
                  </span>
                  <span className={Style.text}>
                    {renderHighlight(line.text, matcher)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
          {emptyTip && (
            <div className={Style.empty}>
              {status?.error ? `${emptyTip}\n${status.error}` : emptyTip}
            </div>
          )}
        </div>
        <div className={Style.sendBar}>
          {/* 发送框刻意不用 HistoryInput：调试命令常常只发一次，
              历史下拉反而挡住日志，因此保持纯输入框不记录历史 */}
          <input
            className={Style.sendInput}
            placeholder={t('serialSendPlaceholder')}
            value={sendText}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
          />
          <select
            className={Style.newline}
            value={newline}
            title={t('serialNewline')}
            onChange={(e) =>
              changeNewline(e.target.value as 'crlf' | 'lf' | 'none')
            }
          >
            <option value="crlf">CRLF</option>
            <option value="lf">LF</option>
            <option value="none">{t('serialNewlineNone')}</option>
          </select>
          <button
            className={Style.sendBtn}
            onClick={() => send()}
            disabled={!status?.open || !sendText.length}
          >
            {t('serialSend')}
          </button>
        </div>
      </div>
    </div>
  )
})
