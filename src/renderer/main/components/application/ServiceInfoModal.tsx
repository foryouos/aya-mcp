import LunaModal from 'luna-modal/react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from 'common/util'
import Style from './ServiceInfoModal.module.scss'
import { IModalProps } from 'share/common/types'
import {
  IServiceBinderInfo,
  IServiceInfo,
  IServiceProcessInfo,
} from 'common/types'

interface IProps extends IModalProps {
  deviceId: string
  service: IServiceInfo
}

type TabKey = 'dumpsys' | 'process' | 'binder' | 'actions'

// dumpsys 输出可能上万行，全量渲染会卡死界面
const MAX_LINES = 1200
const MAX_BYTES = 200000

function detailTarget(service: IServiceInfo): string {
  if (service.origin === 'app') {
    return `${service.packageName}/${service.className}`
  }

  return service.name
}

function formatRss(kb: number): string {
  if (!kb) {
    return '—'
  }
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`
  }

  return `${kb} KB`
}

export default function ServiceInfoModal(props: IProps) {
  const { deviceId, service } = props
  const [tab, setTab] = useState<TabKey>('dumpsys')

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'dumpsys', label: t('tabDumpsys') },
    { key: 'process', label: t('tabProcess') },
    { key: 'binder', label: t('tabBinder') },
    { key: 'actions', label: t('tabActions') },
  ]

  return createPortal(
    <LunaModal
      title={t('serviceDetail')}
      visible={props.visible}
      width={960}
      onClose={props.onClose}
    >
      <div className={Style.head}>
        <div className={Style.name}>{service.name}</div>
        <div className={Style.meta}>
          <span>{t('serviceType')}: {service.kind}</span>
          <span>PID: {service.pid || '—'}</span>
          <span>{t('processName')}: {service.processName || '—'}</span>
          <span>SELinux: {service.selinux || '—'}</span>
        </div>
        {!service.pid ? (
          <div className={Style.hint}>{t('servicePidUnavailable')}</div>
        ) : (
          <div className={Style.hint}>{t('serviceProcessSharedHint')}</div>
        )}
      </div>
      <div className={Style.tabs}>
        {tabs.map((item) => (
          <button
            key={item.key}
            className={tab === item.key ? Style.tabActive : Style.tab}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={Style.panel}>
        {tab === 'dumpsys' && (
          <DumpsysTab deviceId={deviceId} service={service} />
        )}
        {tab === 'process' && (
          <ProcessTab deviceId={deviceId} service={service} />
        )}
        {tab === 'binder' && (
          <BinderTab deviceId={deviceId} service={service} />
        )}
        {tab === 'actions' && (
          <ActionsTab deviceId={deviceId} service={service} />
        )}
      </div>
    </LunaModal>,
    document.body
  )
}

function DumpsysTab(props: { deviceId: string; service: IServiceInfo }) {
  const { deviceId, service } = props
  const [args, setArgs] = useState('')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')

  const run = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await main.getServiceDetail(
        deviceId,
        service.origin,
        detailTarget(service),
        args
      )
      setText(result.output || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setText('')
    } finally {
      setLoading(false)
    }
  }, [deviceId, service, args])

  useEffect(() => {
    run()
    // 只在切换服务时自动执行一次
  }, [deviceId, service.id])

  const lines = useMemo(() => {
    const all = text.split(/\r?\n/)
    let limited = all
    if (text.length > MAX_BYTES) {
      limited = all.slice(0, MAX_LINES)
    }
    return limited.slice(0, MAX_LINES)
  }, [text])

  const truncated = text.length > MAX_BYTES || lines.length >= MAX_LINES
  const hl = keyword.trim().toLowerCase()

  return (
    <div className={Style.column}>
      <div className={Style.row}>
        <input
          className={Style.input}
          value={args}
          placeholder={t('dumpsysArgsPlaceholder')}
          onChange={(e) => setArgs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              run()
            }
          }}
        />
        <button className={Style.btn} onClick={run} disabled={loading}>
          {loading ? t('loading') : t('run')}
        </button>
        <input
          className={Style.input}
          value={keyword}
          placeholder={t('searchInOutput')}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button
          className={Style.btn}
          onClick={() => navigator.clipboard.writeText(text)}
        >
          {t('copyAll')}
        </button>
      </div>
      {error ? (
        <div className={Style.tip}>{error}</div>
      ) : (
        <div className={Style.code}>
          {lines.map((line, index) => (
            <div className={Style.codeLine} key={index}>
              <span className={Style.lineNo}>{index + 1}</span>
              <span className={Style.lineText}>
                {highlightText(line, hl)}
              </span>
            </div>
          ))}
          {truncated && (
            <div className={Style.tip}>
              {t('outputTruncated', { lines: lines.length })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function highlightText(line: string, keyword: string) {
  if (!keyword) {
    return line
  }
  const index = line.toLowerCase().indexOf(keyword)
  if (index < 0) {
    return line
  }

  return (
    <>
      {line.slice(0, index)}
      <mark>{line.slice(index, index + keyword.length)}</mark>
      {line.slice(index + keyword.length)}
    </>
  )
}

function ProcessTab(props: { deviceId: string; service: IServiceInfo }) {
  const { deviceId, service } = props
  const [info, setInfo] = useState<IServiceProcessInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let canceled = false
    setLoading(true)
    setError('')
    main
      .getServiceProcess(deviceId, service.pid, service.processName)
      .then((result) => {
        if (!canceled) {
          setInfo(result)
        }
      })
      .catch((err) => {
        if (!canceled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false)
        }
      })

    return () => {
      canceled = true
    }
  }, [deviceId, service.pid, service.processName])

  if (loading) {
    return <div className={Style.tip}>{t('loading')}</div>
  }
  if (error) {
    return <div className={Style.tip}>{error}</div>
  }
  if (!info) {
    return <div className={Style.tip}>{t('noData')}</div>
  }

  return (
    <div className={Style.column}>
      <div className={Style.kv}>
        <span>PID</span>
        <b>{info.pid || '—'}</b>
        <span>{t('processName')}</span>
        <b>{info.comm || '—'}</b>
        <span>cmdline</span>
        <b className={Style.mono}>{info.cmdline || '—'}</b>
        <span>SELinux</span>
        <b className={Style.mono}>{info.selinux || '—'}</b>
        <span>UID / GID</span>
        <b>
          {info.uid} / {info.gid}
        </b>
        <span>RSS</span>
        <b>{formatRss(info.rssKb)}</b>
      </div>
      <div className={Style.section}>
        <div className={Style.sectionTitle}>{t('initRc')}</div>
        {info.initRc.length ? (
          <ul className={Style.list}>
            {info.initRc.map((item) => (
              <li key={item} className={Style.mono}>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <div className={Style.tip}>{t('initRcNotFound')}</div>
        )}
      </div>
      <div className={Style.section}>
        <div className={Style.sectionTitle}>{t('deviceNodes')}</div>
        {info.fdDenied ? (
          <div className={Style.tip}>{t('fdNeedRoot')}</div>
        ) : info.fds.length ? (
          <ul className={Style.list}>
            {info.fds.map((item, index) => (
              <li key={`${item}-${index}`} className={Style.mono}>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <div className={Style.tip}>{t('noData')}</div>
        )}
      </div>
    </div>
  )
}

function BinderTab(props: { deviceId: string; service: IServiceInfo }) {
  const { deviceId, service } = props
  const [info, setInfo] = useState<IServiceBinderInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let canceled = false
    setLoading(true)
    setError('')
    main
      .getServiceBinder(deviceId, service.pid)
      .then((result) => {
        if (!canceled) {
          setInfo(result)
        }
      })
      .catch((err) => {
        if (!canceled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false)
        }
      })

    return () => {
      canceled = true
    }
  }, [deviceId, service.pid])

  if (loading) {
    return <div className={Style.tip}>{t('loading')}</div>
  }
  if (error) {
    return <div className={Style.tip}>{error}</div>
  }
  if (!info) {
    return <div className={Style.tip}>{t('noData')}</div>
  }
  if (!info.available) {
    return <div className={Style.tip}>{info.error || t('binderUnavailable')}</div>
  }

  const max = service.threadMax || 0
  const used = service.threadCurrent || info.threads

  return (
    <div className={Style.column}>
      <div className={Style.kv}>
        <span>{t('binderContext')}</span>
        <b className={Style.mono}>{info.context || '—'}</b>
        <span>{t('binderThreads')}</span>
        <b>
          {used}
          {max ? ` / ${max}` : ''}
        </b>
        <span>{t('binderNodes')}</span>
        <b>{info.nodes}</b>
      </div>
      <div className={Style.section}>
        <div className={Style.sectionTitle}>
          {t('binderRefs', { total: info.refs.length })}
        </div>
        {info.refs.length ? (
          <div className={Style.chips}>
            {info.refs.map((pid) => (
              <span key={pid} className={Style.chip}>
                {pid}
              </span>
            ))}
          </div>
        ) : (
          <div className={Style.tip}>{t('noData')}</div>
        )}
      </div>
    </div>
  )
}

function ActionsTab(props: { deviceId: string; service: IServiceInfo }) {
  const { deviceId, service } = props
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState('')
  const [seconds, setSeconds] = useState(3)
  const [tracePath, setTracePath] = useState('')

  async function captureStack() {
    setBusy('stack')
    try {
      const result = await main.captureServiceStack(deviceId, service.pid)
      setLog(
        (prev) =>
          `${prev}${prev ? '\n' : ''}=== debuggerd -b ${service.pid} ===\n${
            result.ok ? result.output : `[失败] ${result.error}\n${result.output}`
          }`
      )
    } catch (err) {
      setLog((prev) => `${prev}\n[异常] ${String(err)}`)
    } finally {
      setBusy('')
    }
  }

  async function openLogcat() {
    if (!service.pid) {
      return
    }
    const filterText = `pid:${service.pid}`
    try {
      await navigator.clipboard.writeText(filterText)
    } catch {
      // 剪贴板可能不可用，忽略
    }
    setLog((prev) => `${prev}${prev ? '\n' : ''}已复制过滤条件 ${filterText}，可在日志面板粘贴`)
    await main.openLogcat(deviceId)
  }

  async function captureTrace() {
    setBusy('trace')
    setTracePath('')
    try {
      const result = await main.captureAtrace(deviceId, seconds)
      setTracePath(result.path)
      setLog(
        (prev) =>
          `${prev}${prev ? '\n' : ''}atrace 已保存：${result.path}（${result.bytes} 字节）`
      )
    } catch (err) {
      setLog((prev) => `${prev}\n[atrace 失败] ${String(err)}`)
    } finally {
      setBusy('')
    }
  }

  const disabled = !service.pid

  return (
    <div className={Style.column}>
      <div className={Style.row}>
        <button className={Style.btn} onClick={captureStack} disabled={disabled || !!busy}>
          {busy === 'stack' ? t('loading') : t('actionStack')}
        </button>
        <button className={Style.btn} onClick={openLogcat} disabled={disabled}>
          {t('actionLogcat')}
        </button>
        <button className={Style.btn} onClick={captureTrace} disabled={!!busy}>
          {busy === 'trace' ? t('loading') : t('actionTrace')}
        </button>
        <label className={Style.inline}>
          {t('traceSeconds')}
          <input
            className={Style.inputSmall}
            type="number"
            min={1}
            max={30}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value) || 3)}
          />
        </label>
        {tracePath && (
          <button
            className={Style.btn}
            onClick={() => main.showItemInFolder(tracePath)}
          >
            {t('openTraceFolder')}
          </button>
        )}
      </div>
      {disabled && <div className={Style.tip}>{t('needPid')}</div>}
      <pre className={Style.log}>{log || t('actionHint')}</pre>
    </div>
  )
}
