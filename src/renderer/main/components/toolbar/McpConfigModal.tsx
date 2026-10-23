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
      // 开启局域网时默认展示 HTTP 配置，方便跨设备/服务器复制
      setTab(store.mcp.lan ? 'http' : 'stdio')
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
        <p className={Style.tipWarn}>{t('mcpConfigRemoteTip')}</p>
        {store.mcp.lan && store.mcp.lanIps.length > 0 && (
          <div className={Style.lanIps}>
            <span className={Style.lanIpsLabel}>{t('mcpLanIps')}</span>
            {store.mcp.lanIps.map((ip) => (
              <code key={ip} className={Style.lanIp}>
                {ip}
              </code>
            ))}
            <span className={Style.lanIpsHint}>{t('mcpLanIpsHint')}</span>
          </div>
        )}
      </div>
    </LunaModal>,
    document.body
  )
})
