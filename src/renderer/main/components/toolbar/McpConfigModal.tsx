import { useEffect, useRef, useState } from 'react'
import LunaModal from 'luna-modal/react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { t } from 'common/util'
import { IModalProps } from 'share/common/types'
import className from 'licia/className'
import store from '../../store'
import Style from './McpConfigModal.module.scss'

type TabKey = 'stdio' | 'node' | 'http'

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'stdio', label: 'mcpConfigStdio' },
  { key: 'node', label: 'mcpConfigNode' },
  { key: 'http', label: 'mcpConfigHttp' },
]

export default observer(function McpConfigModal(props: IModalProps) {
  const [tab, setTab] = useState<TabKey>('stdio')
  const [copied, setCopied] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (props.visible) {
      setCopied('')
      store.mcp.getConfigs()
    }
  }, [props.visible])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const configs = store.mcp.configs
  const code = configs ? configs[tab] : ''

  async function copy() {
    if (!code) {
      return
    }
    await navigator.clipboard.writeText(code)
    setCopied(tab)
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
    }
    timerRef.current = window.setTimeout(() => setCopied(''), 1500)
  }

  return createPortal(
    <LunaModal
      title={t('mcpConfigTitle')}
      width={560}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.container}>
        <div className={Style.tabs}>
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              className={className(Style.tab, tab === key && Style.active)}
              onClick={() => setTab(key)}
            >
              {t(label)}
            </button>
          ))}
          <button className={Style.copy} onClick={copy} disabled={!code}>
            {copied === tab ? t('mcpCopied') : t('mcpCopy')}
          </button>
        </div>
        <pre className={Style.code}>{code}</pre>
        <p className={Style.tip}>{t('mcpConfigTip')}</p>
        <p className={Style.tip}>{t('mcpConfigTokenTip')}</p>
      </div>
    </LunaModal>,
    document.body
  )
})
