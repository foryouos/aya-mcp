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
// 搜索只用于定位，不过滤日志；匹配行最多保留最近的 5000 条用于逐个跳转
const SEARCH_MATCH_LIMIT = 5000
// 命中行不在本地缓冲时，向主进程取这一段上下文展示
const CONTEXT_BEFORE = 24
const CONTEXT_AFTER = 80
const CONTEXT_VISUAL_RADIUS = 3

// 主板调试口常用波特率，只保留最常见的三个
const BAUD_RATES = ['115200', '921600', '1500000']

const SOURCE_LABELS: Record<SerialSource, string> = {
  bootloader: 'serialBootloader',
  kernel: 'serialKernel',
  android: 'serialAndroid',
  other: 'serialOther',
}

// CSS Modules 用 camelCaseOnly 导出，下划线类名只能按驼峰取，
// 之前用 Style[`row_${source}`] 一直是 undefined，阶段色条其实没生效
const ROW_CLASSES: Record<SerialSource, string> = {
  bootloader: Style.rowBootloader,
  kernel: Style.rowKernel,
  android: Style.rowAndroid,
  other: Style.rowOther,
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

function renderHighlight(text: string, matcher: RegExp | null, active = false) {
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
      <mark
        key={key++}
        className={active ? Style.highlightActive : Style.highlight}
      >
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
  // 用户上滑后不再自动跟随，用这个数字提示“下面还有新日志”
  const [pendingNew, setPendingNew] = useState(0)
  // 搜索只定位不筛选：这里记录命中的行和当前定位到第几条
  const [matchIndex, setMatchIndex] = useState(-1)
  const [matchCount, setMatchCount] = useState(0)
  const [activeSeq, setActiveSeq] = useState(0)
  const [contextWindow, setContextWindow] = useState<{
    centerSeq: number
    lines: ISerialLine[]
  } | null>(null)

  const linesRef = useRef<ISerialLine[]>([])
  const filteredRef = useRef<ISerialLine[]>([])
  const matchesRef = useRef<ISerialLine[]>([])
  const activeMatchRef = useRef(-1)
  const activeSeqRef = useRef(0)
  const contextWindowRef = useRef<{
    centerSeq: number
    lines: ISerialLine[]
  } | null>(null)
  const pendingScrollSeqRef = useRef<number | null>(null)
  const filterRef = useRef({
    search: '',
    useRegex: false,
    source: 'all' as string,
  })
  const atBottomRef = useRef(true)
  const autoScrollRef = useRef(true)
  const manualPauseRef = useRef(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const charWidthRef = useRef(7.2)
  // 事件回调是一次性闭包，读 React state 会拿到旧值，最长行宽度必须走 ref
  const maxLengthRef = useRef(0)
  const syncTokenRef = useRef(0)
  const searchTokenRef = useRef(0)
  const statusRef = useRef<ISerialStatus | null>(null)
  // 已收到的最新行号，用来发现推送批次丢失（渲染进程忙、暂停恢复等）并自动补齐
  const lastSeqRef = useRef(0)
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingNewRef = useRef(0)
  statusRef.current = status

  const matcher = useMemo(
    () => buildMatcher(search, useRegex),
    [search, useRegex]
  )

  function isFilterActive() {
    return filterRef.current.source !== 'all'
  }

  function lineSourceMatch(line: ISerialLine, src: string) {
    return src === 'all' || line.source === src
  }

  // 动画帧覆盖的是缓冲区末尾的行，从尾部往前找几条足够；找不到就按新行处理
  function findLineBySeq(seq: number) {
    const lines = linesRef.current
    for (
      let i = lines.length - 1, n = Math.max(0, lines.length - 8);
      i >= n;
      i--
    ) {
      if (lines[i].seq === seq) {
        return lines[i]
      }
    }
    return null
  }

  function setLines(list: ISerialLine[]) {
    linesRef.current = list
    lastSeqRef.current = list.length ? list[list.length - 1].seq : 0
    let max = 0
    for (const line of list) {
      if (line.text.length > max) {
        max = line.text.length
      }
    }
    maxLengthRef.current = max
    setMaxLength(max)
    rebuildFiltered()
    setVersion((v) => v + 1)
  }

  // 会话被重建/清空时，本地缓冲全部作废
  function resetLocal() {
    linesRef.current = []
    filteredRef.current = []
    clearSearchState()
    lastSeqRef.current = 0
    pendingNewRef.current = 0
    maxLengthRef.current = 0
    setPendingNew(0)
    setMaxLength(0)
    setVersion((v) => v + 1)
  }

  function rebuildFiltered() {
    const f = filterRef.current
    filteredRef.current =
      f.source === 'all'
        ? linesRef.current
        : linesRef.current.filter((line) => line.source === f.source)
  }

  function updateContextWindow(
    next: {
      centerSeq: number
      lines: ISerialLine[]
    } | null
  ) {
    contextWindowRef.current = next
    setContextWindow(next)
    setVersion((v) => v + 1)
  }

  function clearSearchState() {
    const hadContext = !!contextWindowRef.current
    pendingScrollSeqRef.current = null
    matchesRef.current = []
    activeMatchRef.current = -1
    activeSeqRef.current = 0
    setMatchIndex(-1)
    setMatchCount(0)
    setActiveSeq(0)
    if (hadContext) {
      updateContextWindow(null)
    }
  }

  // 滚到指定行并尽量居中；返回 false 表示该行不在当前列表里
  function scrollToLine(seq: number) {
    const lines = contextWindowRef.current
      ? contextWindowRef.current.lines
      : filteredRef.current
    const index = lines.findIndex((line) => line.seq === seq)
    const viewport = viewportRef.current
    if (index < 0 || !viewport) {
      return false
    }
    const top = Math.max(
      0,
      index * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2
    )
    viewport.scrollTop = top
    setScrollTop(top)
    atBottomRef.current = false
    autoScrollRef.current = false
    setAutoScroll(false)
    return true
  }

  // 命中行不在本地缓冲时，从主进程取前后一段作为上下文
  async function loadContext(seq: number) {
    const token = ++searchTokenRef.current
    try {
      const res = await main.serialQuery({
        fromSeq: Math.max(1, seq - CONTEXT_BEFORE),
        toSeq: seq + CONTEXT_AFTER,
        lines: 0,
        source: filterRef.current.source as any,
      })
      if (token !== searchTokenRef.current) {
        return
      }
      updateContextWindow({ centerSeq: seq, lines: res.lines })
      pendingScrollSeqRef.current = seq
    } catch {
      if (token === searchTokenRef.current) {
        backToLive()
      }
    }
  }

  function goToMatch(delta: number) {
    const matches = matchesRef.current
    if (!matches.length) {
      return
    }
    // 丢弃上一次定位尚未执行的滚动，避免跳到已经失效的目标
    pendingScrollSeqRef.current = null
    const current = activeMatchRef.current
    const index =
      current < 0 || current >= matches.length
        ? delta > 0
          ? 0
          : matches.length - 1
        : (current + delta + matches.length) % matches.length
    activeMatchRef.current = index
    const seq = matches[index].seq
    activeSeqRef.current = seq
    setMatchIndex(index)
    setActiveSeq(seq)

    // 优先在完整日志里定位；本地缓冲没有时再看历史上下文视图
    if (filteredRef.current.some((line) => line.seq === seq)) {
      if (contextWindowRef.current) {
        updateContextWindow(null)
        pendingScrollSeqRef.current = seq
      } else {
        scrollToLine(seq)
      }
      return
    }
    if (contextWindowRef.current?.lines.some((line) => line.seq === seq)) {
      scrollToLine(seq)
      return
    }
    loadContext(seq)
  }

  function backToLive() {
    pendingScrollSeqRef.current = null
    if (contextWindowRef.current) {
      updateContextWindow(null)
    }
    setAutoScroll(true)
  }

  // 搜索只定位不筛选：向主进程取命中行用于逐个跳转，完整日志始终留在列表里
  async function applyFilter() {
    const f = filterRef.current
    const token = ++searchTokenRef.current
    pendingScrollSeqRef.current = null
    rebuildFiltered()
    if (!f.search.trim()) {
      clearSearchState()
      setVersion((v) => v + 1)
      return
    }

    const prevSeq = activeSeqRef.current
    try {
      const res = await main.serialQuery({
        keyword: f.search,
        regex: f.useRegex,
        source: f.source as any,
        lines: SEARCH_MATCH_LIMIT,
        // 取最近的命中行，跳转时默认停在最靠近当前时间的一条
        latest: true,
      })
      if (token !== searchTokenRef.current) {
        return
      }
      matchesRef.current = res.lines
      setMatchCount(res.lines.length)
      if (!res.lines.length) {
        activeMatchRef.current = -1
        activeSeqRef.current = 0
        setMatchIndex(-1)
        setActiveSeq(0)
        if (contextWindowRef.current) {
          updateContextWindow(null)
        }
        setVersion((v) => v + 1)
        return
      }
      // 同步新日志后尽量保留用户当前看的那条命中，避免又跳回最后一条
      const keep = prevSeq
        ? res.lines.findIndex((line) => line.seq === prevSeq)
        : -1
      const index = keep >= 0 ? keep : res.lines.length - 1
      activeMatchRef.current = index
      const seq = res.lines[index].seq
      activeSeqRef.current = seq
      setMatchIndex(index)
      setActiveSeq(seq)
      if (contextWindowRef.current?.centerSeq === seq) {
        setVersion((v) => v + 1)
        return
      }
      if (contextWindowRef.current) {
        updateContextWindow(null)
      }
      if (filteredRef.current.some((line) => line.seq === seq)) {
        scrollToLine(seq)
      } else {
        loadContext(seq)
      }
    } catch {
      if (token !== searchTokenRef.current) {
        return
      }
      clearSearchState()
    }
    setVersion((v) => v + 1)
  }

  function appendLines(incoming: ISerialLine[]) {
    if (!incoming.length) {
      return
    }
    const lines = linesRef.current
    const f = filterRef.current
    const active = isFilterActive()
    // 无过滤时 filtered 与 lines 是同一个数组，再 push 一次会凭空多出一行
    const separate = filteredRef.current !== lines
    let max = maxLengthRef.current

    for (const line of incoming) {
      // 主进程会把 loader 模式的转圈动画合并为同一行原地更新（seq 重复推送），
      // 命中已有行时按 seq 覆盖内容，而不是追加成新行刷屏
      const existing =
        lines.length && lines[lines.length - 1].seq === line.seq
          ? lines[lines.length - 1]
          : line.seq < lastSeqRef.current
            ? findLineBySeq(line.seq)
            : null
      if (existing) {
        existing.text = line.text
        existing.time = line.time
        continue
      }
      lines.push(line)
      if (line.text.length > max) {
        max = line.text.length
      }
      if (active && separate && lineSourceMatch(line, f.source)) {
        filteredRef.current.push(line)
      }
    }

    if (max !== maxLengthRef.current) {
      maxLengthRef.current = max
      setMaxLength(max)
    }

    if (!autoScrollRef.current) {
      pendingNewRef.current += incoming.length
      setPendingNew(pendingNewRef.current)
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
        const next =
          saved && list.some((port) => port.path === saved)
            ? saved
            : list[0]?.path || ''
        return next
      })
    })
  }

  async function syncRecent(follow = true) {
    const token = ++syncTokenRef.current
    try {
      // latest：拿缓冲里最新的 N 行，否则缓冲区涨到 20 万行后会一直显示会话开头
      const res = await main.serialQuery({
        lines: MAX_LOCAL_LINES,
        latest: true,
      })
      if (token !== syncTokenRef.current) {
        return
      }
      setStatus(res.status)
      // 查询期间可能又有新行通过推送到达，把这段尾巴接回去，别被快照覆盖掉
      const snapLast = res.lines.length
        ? res.lines[res.lines.length - 1].seq
        : 0
      const tail = linesRef.current.filter((line) => line.seq > snapLast)
      setLines(tail.length ? res.lines.concat(tail) : res.lines)
      if (isFilterActive() || filterRef.current.search.trim()) {
        // 保持搜索条件时重新从主进程完整缓冲刷新匹配结果
        applyFilter()
        return
      }
      if (follow) {
        atBottomRef.current = true
        setAutoScroll(true)
      }
    } catch {
      // 主进程未就绪时忽略
    }
  }

  // 发现日志断号后延迟补一次快照，避免频繁重查
  function scheduleResync() {
    if (resyncTimerRef.current) {
      return
    }
    resyncTimerRef.current = setTimeout(() => {
      resyncTimerRef.current = null
      syncRecent(false)
    }, 300)
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
      if (
        current &&
        payload.sessionId &&
        current.sessionId !== payload.sessionId
      ) {
        return
      }
      const incoming = payload.lines
      const first = incoming.length ? incoming[0].seq : 0
      // 两次推送之间的行号不连续，说明中间丢了批次（渲染进程忙、暂停恢复、
      // 主进程重启等），补一次快照，否则日志框会一直缺那一段
      if (
        first > 0 &&
        lastSeqRef.current > 0 &&
        first > lastSeqRef.current + 1
      ) {
        scheduleResync()
      }
      if (first > 0) {
        lastSeqRef.current = incoming[incoming.length - 1].seq
      }
      appendLines(incoming)
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              dropped: payload.dropped,
              bytes: payload.bytes,
              logFileSize: payload.logFileSize,
              lines: prev.lines + incoming.length,
            }
          : prev
      )
    })
    const offStatus = main.on('serialStatus', (next: ISerialStatus) => {
      if (!alive) {
        return
      }
      const prev = statusRef.current
      // 会话被重建或清空（MCP 重新打开串口、清空缓冲等）时本地数据已失效
      const reset =
        !!prev &&
        (prev.sessionId !== next.sessionId || next.seq < lastSeqRef.current)
      setStatus(next)
      if (reset) {
        resetLocal()
        syncRecent()
        return
      }
      lastSeqRef.current = Math.max(lastSeqRef.current, next.seq)
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
      if (resyncTimerRef.current) {
        clearTimeout(resyncTimerRef.current)
        resyncTimerRef.current = null
      }
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
      }
      // 无论是否手动暂停，回到面板都同步一次缓冲区，
      // 否则暂停期间攒下的日志一直看不到，像是“有数据但没日志”
      syncRecent()
    } else if (!manualPauseRef.current) {
      main.serialSetPaused(true)
    }
  }, [panel])

  useEffect(() => {
    autoScrollRef.current = autoScroll
    const viewport = viewportRef.current
    if (!viewport || !autoScroll) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
    setScrollTop(viewport.scrollTop)
    if (pendingNewRef.current) {
      pendingNewRef.current = 0
      setPendingNew(0)
    }
  }, [version, autoScroll])

  // 历史上下文切换后列表内容变了，等渲染完再滚到目标行
  useEffect(() => {
    const seq = pendingScrollSeqRef.current
    if (seq == null) {
      return
    }
    pendingScrollSeqRef.current = null
    scrollToLine(seq)
  }, [version])

  const filtered = filteredRef.current
  const displayLines = contextWindow ? contextWindow.lines : filtered
  const total = linesRef.current.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const end = Math.min(displayLines.length, start + visibleCount)
  const visible = displayLines.slice(start, end)
  const contentWidth = Math.max(
    viewportWidth,
    Math.min(maxLength, 8192) * charWidthRef.current + 200
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
      resetLocal()
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
        // 搜索现在只用于定位，导出仍按“当前视图”保存：来源筛选生效，关键词不裁剪
        mode === 'view' ? { source } : {}
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
      resetLocal()
      atBottomRef.current = true
      setAutoScroll(true)
    })
  }

  function scrollToEnd() {
    pendingScrollSeqRef.current = null
    if (contextWindowRef.current) {
      updateContextWindow(null)
    }
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      setScrollTop(viewport.scrollTop)
    }
    atBottomRef.current = true
    pendingNewRef.current = 0
    setPendingNew(0)
    setAutoScroll(true)
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

  const filterActive = source !== 'all'
  const searching = !!search.trim()
  const counter = searching
    ? `${matchIndex >= 0 ? matchIndex + 1 : 0}/${matchCount}`
    : `${filtered.length}/${total}`
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
          onEnter={() => goToMatch(1)}
        />
        <ToolbarIcon
          icon="text"
          state={useRegex ? 'hover' : ''}
          title={t('serialRegex')}
          onClick={() => setUseRegex(!useRegex)}
        />
        <ToolbarIcon
          icon="arrow-left"
          title={t('serialPrevMatch')}
          onClick={() => goToMatch(-1)}
          disabled={!matchCount}
        />
        <ToolbarIcon
          icon="arrow-right"
          title={t('serialNextMatch')}
          onClick={() => goToMatch(1)}
          disabled={!matchCount}
        />
        <LunaToolbarText
          text={`${counter}${status?.paused ? ` ${t('serialPaused')}` : ''}`}
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
          onClick={scrollToEnd}
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
            autoScrollRef.current = atBottom
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
                height: displayLines.length * ROW_HEIGHT,
                width: contentWidth,
              }}
            >
              {visible.map((line, index) => {
                const absIndex = start + index
                const prevLine =
                  absIndex > 0 ? displayLines[absIndex - 1] : null
                // 阶段切换处画一条分隔线，让 loader 到 kernel 的衔接一目了然
                const stageStart =
                  !!prevLine &&
                  !line.tx &&
                  !prevLine.tx &&
                  prevLine.source !== line.source
                const isActive = !!activeSeq && line.seq === activeSeq
                const isContext =
                  !!activeSeq &&
                  !isActive &&
                  Math.abs(line.seq - activeSeq) <= CONTEXT_VISUAL_RADIUS
                return (
                  <div
                    key={line.seq}
                    className={[
                      Style.row,
                      line.tx ? Style.rowTx : ROW_CLASSES[line.source],
                      stageStart ? Style.stageStart : '',
                      isActive ? Style.rowActive : '',
                      isContext ? Style.rowContext : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ top: (start + index) * ROW_HEIGHT }}
                  >
                    <span className={Style.lineNo}>{line.seq}</span>
                    <span className={Style.time}>
                      {dateFormat(new Date(line.time), 'HH:MM:ss.l')}
                    </span>
                    <span
                      className={`${Style.badge} ${
                        line.tx ? Style.tx : Style[line.source]
                      }`}
                    >
                      {t(line.tx ? 'serialSend' : SOURCE_LABELS[line.source])}
                    </span>
                    <span className={Style.text}>
                      {renderHighlight(line.text, matcher, isActive)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {searching && !matchCount && (
            <div className={Style.searchTip}>{t('serialNoMatch')}</div>
          )}
          {contextWindow && (
            <div className={Style.contextBanner}>
              <span>
                {t('serialSearchLocated', {
                  seq: String(activeSeq || contextWindow.centerSeq),
                })}
              </span>
              <button onClick={backToLive}>{t('serialBackToLive')}</button>
            </div>
          )}
          {emptyTip && (
            <div className={Style.empty}>
              {status?.error ? `${emptyTip}\n${status.error}` : emptyTip}
            </div>
          )}
        </div>
        {/* 用户翻上去看历史时不再自动滚动，这里提示下面还有多少新日志 */}
        {pendingNew > 0 && !autoScroll && (
          <button className={Style.newLines} onClick={scrollToEnd}>
            ↓ {t('serialNewLines', { n: String(pendingNew) })}
          </button>
        )}
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
          <span className={Style.newlineLabel}>{t('serialNewline')}</span>
          <select
            className={Style.newline}
            value={newline}
            title={t('serialNewlineHint')}
            aria-label={t('serialNewline')}
            onChange={(e) =>
              changeNewline(e.target.value as 'crlf' | 'lf' | 'none')
            }
          >
            <option value="crlf">{t('serialNewlineCrlf')}</option>
            <option value="lf">{t('serialNewlineLf')}</option>
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
