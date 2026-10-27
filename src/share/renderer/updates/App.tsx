import { ReactNode, useEffect, useRef, useState } from 'react'
import className from 'licia/className'
import dateFormat from 'licia/dateFormat'
import fileSize from 'licia/fileSize'
import { IUpdateState, UpdatePhase } from 'common/types'
import { t } from 'common/util'
import icon from '../../../renderer/assets/icon.png'
import Style from './App.module.scss'

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
const RELEASE_PAGE = 'https://github.com/foryouos/aya-mcp/releases'

function openExternal(url: string) {
  main.openExternal(url)
}

function renderInline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = new RegExp(INLINE_PATTERN.source, 'g')
  let last = 0
  let index = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }

    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${key}-b${index++}`}>{token.slice(2, -2)}</strong>,
      )
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={`${key}-c${index++}`} className={Style.code}>
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <a
            key={`${key}-a${index++}`}
            className={Style.inlineLink}
            onClick={() => openExternal(link[2])}
          >
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }

    last = match.index + token.length
  }

  if (last < text.length) {
    nodes.push(text.slice(last))
  }

  return nodes
}

// 轻量 Markdown 渲染：只处理标题、列表、引用和代码块，避免引入额外依赖
function renderNotes(notes: string) {
  const blocks: ReactNode[] = []
  const lines = notes.split('\n')
  let list: string[] = []
  let code: string[] | null = null
  let key = 0

  const flushList = () => {
    if (!list.length) return
    blocks.push(
      <ul key={`list-${key++}`}>
        {list.map((item, i) => (
          <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push(
          <pre key={`code-${key++}`}>
            <code>{code.join('\n')}</code>
          </pre>,
        )
        code = null
      } else {
        flushList()
        code = []
      }
      continue
    }

    if (code) {
      code.push(raw)
      continue
    }

    if (!line.trim()) {
      flushList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length, 3)
      const Tag = `h${level}` as unknown as 'h1'
      blocks.push(
        <Tag key={`h-${key++}`}>{renderInline(heading[2], `h-${key}`)}</Tag>,
      )
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      list.push(bullet[1])
      continue
    }

    const quote = /^>\s+(.*)$/.exec(line)
    if (quote) {
      flushList()
      blocks.push(
        <blockquote key={`q-${key++}`}>
          {renderInline(quote[1], `q-${key}`)}
        </blockquote>,
      )
      continue
    }

    flushList()
    blocks.push(<p key={`p-${key++}`}>{renderInline(line, `p-${key}`)}</p>)
  }

  if (code) {
    blocks.push(
      <pre key={`code-${key++}`}>
        <code>{code.join('\n')}</code>
      </pre>,
    )
  }
  flushList()

  return blocks
}

function StatusIcon({ phase }: { phase: UpdatePhase }) {
  if (phase === 'checking' || phase === 'idle') {
    return <span className={Style.spinner} />
  }

  if (phase === 'latest' || phase === 'downloaded') {
    return (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (phase === 'error') {
    return (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <path
          d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M12 9v4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
    )
  }

  if (phase === 'downloading') {
    return (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <path
          d="M12 4v11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="m7 10 5 5 5-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5 19h14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
      <path
        d="M12 16V4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m7 9 5-5 5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function formatDate(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''

  return dateFormat(date, 'yyyy-mm-dd')
}

export default function App() {
  const [state, setState] = useState<IUpdateState | null>(null)
  const [installing, setInstalling] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    let alive = true

    const off = main.on('updateState', (next: IUpdateState) => {
      if (alive) setState(next)
    })

    main.getUpdateState().then((current: IUpdateState) => {
      if (!alive) return
      setState(current)

      const busy =
        current.phase === 'checking' ||
        current.phase === 'downloading' ||
        current.phase === 'downloaded'
      const stale = Date.now() - (current.checkedAt || 0) > 60 * 1000

      if (!busy && !started.current && (current.phase === 'idle' || stale)) {
        started.current = true
        main
          .checkUpdate(true)
          .then((next: IUpdateState) => {
            if (alive) setState(next)
          })
          .catch(() => {
            // 主进程已把失败原因写入状态，这里只避免未捕获的 rejection
          })
      }
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  if (!state) {
    return (
      <div className={Style.container}>
        <div className={Style.loading}>
          <span className={Style.spinner} />
        </div>
      </div>
    )
  }

  const phase = state.phase
  const release = state.release
  const hasUpdate = state.hasUpdate && !!release
  const downloading = phase === 'downloading'

  async function check() {
    try {
      setState(await main.checkUpdate(false))
    } catch {
      // ignore
    }
  }

  async function download() {
    try {
      setState(await main.downloadUpdate())
    } catch {
      // ignore
    }
  }

  async function cancel() {
    try {
      setState(await main.cancelUpdateDownload())
    } catch {
      // ignore
    }
  }

  async function install() {
    if (installing) return
    setInstalling(true)
    try {
      setState(await main.installUpdate())
    } catch {
      // ignore
    } finally {
      setInstalling(false)
    }
  }

  let title = ''
  let desc = ''

  switch (phase) {
    case 'idle':
    case 'checking':
      title = t('updateCheckingTitle')
      desc = t('updateCheckingDesc')
      break
    case 'latest':
      title = t('updateLatestTitle')
      desc = t('updateLatestDesc', { version: state.currentVersion })
      break
    case 'available':
      title = t('updateAvailableTitle')
      desc = t('updateAvailableDesc', { version: release?.version || '' })
      break
    case 'downloading':
      title = t('updateDownloadingTitle')
      desc = t('updateDownloadingDesc')
      break
    case 'downloaded':
      title = t('updateDownloadedTitle')
      desc = t('updateDownloadedDesc')
      break
    default:
      title = t('updateFailedTitle')
      desc = state.error || t('updateErr')
  }

  let actions: ReactNode = null

  if (phase === 'latest') {
    actions = (
      <button className={Style.btn} onClick={check}>
        {t('updateCheckAgain')}
      </button>
    )
  } else if (phase === 'available') {
    actions = state.asset ? (
      <>
        <button
          className={className(Style.btn, Style.btnPrimary)}
          onClick={download}
        >
          {t('updateDownload')}
        </button>
        <button
          className={Style.btn}
          onClick={() => openExternal(release!.url)}
        >
          {t('updateOpenRelease')}
        </button>
      </>
    ) : (
      <button
        className={className(Style.btn, Style.btnPrimary)}
        onClick={() => openExternal(release!.url)}
      >
        {t('updateOpenRelease')}
      </button>
    )
  } else if (phase === 'downloading') {
    actions = (
      <button className={Style.btn} onClick={cancel}>
        {t('updateCancelDownload')}
      </button>
    )
  } else if (phase === 'downloaded') {
    actions = (
      <>
        <button
          className={className(Style.btn, Style.btnPrimary)}
          onClick={install}
          disabled={installing}
        >
          {t('updateInstall')}
        </button>
        <button
          className={Style.btn}
          onClick={() => main.showItemInFolder(state.downloadedPath)}
        >
          {t('updateShowInFolder')}
        </button>
      </>
    )
  } else if (phase === 'error') {
    actions = (
      <>
        <button
          className={className(Style.btn, Style.btnPrimary)}
          onClick={hasUpdate ? download : check}
        >
          {t('updateRetry')}
        </button>
        <button
          className={Style.btn}
          onClick={() => openExternal(release ? release.url : RELEASE_PAGE)}
        >
          {t('updateOpenRelease')}
        </button>
      </>
    )
  }

  const progress = Math.max(0, Math.min(100, state.progress || 0))
  const publishedAt = release ? formatDate(release.publishedAt) : ''

  return (
    <div className={className(Style.container, !hasUpdate && Style.centered)}>
      <header className={Style.header}>
        <img className={Style.logo} src={icon} />
        <span className={Style.product}>{PRODUCT_NAME}</span>
        <span className={Style.version}>
          {t('updateCurrentVersion')} v{state.currentVersion}
        </span>
      </header>

      <div className={Style.status}>
        <div
          className={className(
            Style.iconWrap,
            phase === 'latest' || phase === 'downloaded'
              ? Style.iconSuccess
              : phase === 'error'
                ? Style.iconError
                : Style.iconPrimary,
          )}
        >
          <StatusIcon phase={phase} />
        </div>
        <div className={Style.statusBody}>
          <div className={Style.title}>{title}</div>
          <div className={Style.desc}>{desc}</div>
        </div>
      </div>

      {hasUpdate && phase !== 'downloading' ? (
        <div className={Style.versions}>
          <span className={Style.versionTag}>v{state.currentVersion}</span>
          <span className={Style.arrow}>→</span>
          <span className={className(Style.versionTag, Style.versionTagNew)}>
            v{release!.version}
          </span>
          {publishedAt ? (
            <span className={Style.meta}>{publishedAt}</span>
          ) : null}
          {state.asset && state.asset.size ? (
            <span className={Style.meta}>{fileSize(state.asset.size)}</span>
          ) : null}
        </div>
      ) : null}

      {downloading ? (
        <div className={Style.progressWrap}>
          <div className={Style.progress}>
            <div
              className={Style.progressBar}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className={Style.progressMeta}>
            <span>
              {t('updateProgressDetail', {
                received: fileSize(state.received),
                total: state.total ? fileSize(state.total) : '?',
              })}
            </span>
            <span>{progress.toFixed(progress >= 100 ? 0 : 1)}%</span>
          </div>
        </div>
      ) : null}

      {phase === 'downloaded' && state.downloadedPath ? (
        <div className={Style.path} title={state.downloadedPath}>
          {state.downloadedPath}
        </div>
      ) : null}

      {hasUpdate ? (
        <section className={Style.notes}>
          <div className={Style.notesTitle}>{t('updateReleaseNotes')}</div>
          <div className={Style.notesBody}>
            {release!.notes ? (
              renderNotes(release!.notes)
            ) : (
              <p className={Style.notesEmpty}>{t('updateNoNotes')}</p>
            )}
          </div>
        </section>
      ) : null}

      {actions ? <div className={Style.actions}>{actions}</div> : null}

      {hasUpdate && phase === 'available' && !state.asset ? (
        <div className={Style.hint}>{t('updateNoAssetTip')}</div>
      ) : null}

      <footer className={Style.footer}>
        <span>
          {state.checkedAt
            ? t('updateLastChecked', {
                time: dateFormat(new Date(state.checkedAt), 'yyyy-mm-dd HH:MM'),
              })
            : t('updateNotChecked')}
        </span>
        <span className={Style.divider}>·</span>
        <button
          className={Style.linkBtn}
          onClick={() => openExternal(RELEASE_PAGE)}
        >
          {t('updateOpenRelease')}
        </button>
      </footer>
    </div>
  )
}
