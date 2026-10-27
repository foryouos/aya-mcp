import { useEffect, useState } from 'react'
import { IUpdateState } from 'common/types'
import { t } from 'common/util'
import Style from './UpdateBanner.module.scss'

const DISMISS_KEY = 'aya.updateBanner.dismissed'

function isDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

// 启动时静默检查到新版本后，在主窗口右下角给出轻量提醒
export default function UpdateBanner() {
  const [state, setState] = useState<IUpdateState | null>(null)
  const [dismissed, setDismissed] = useState(isDismissed)

  useEffect(() => {
    let alive = true

    const off = main.on('updateState', (next: IUpdateState) => {
      if (alive) setState(next)
    })

    main.getUpdateState().then((next: IUpdateState) => {
      if (alive) setState(next)
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  function dismiss() {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // ignore
    }
  }

  if (
    dismissed ||
    !state ||
    !state.hasUpdate ||
    state.phase !== 'available' ||
    !state.release
  ) {
    return null
  }

  return (
    <div className={Style.banner}>
      <div className={Style.icon}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
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
      </div>
      <div className={Style.content}>
        <div className={Style.title}>{t('updateBannerTitle')}</div>
        <div className={Style.desc}>
          {t('updateBannerDesc', {
            version: state.release.version,
            current: state.currentVersion,
          })}
        </div>
      </div>
      <div className={Style.actions}>
        <button
          className={Style.primary}
          onClick={() => main.showUpdateWindow()}
        >
          {t('updateView')}
        </button>
        <button
          className={Style.close}
          title={t('updateDismiss')}
          onClick={dismiss}
        >
          ×
        </button>
      </div>
    </div>
  )
}
