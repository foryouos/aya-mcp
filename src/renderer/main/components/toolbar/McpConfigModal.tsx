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

// 从 url 里取主机部分，如 http://192.168.1.65:7788/mcp -> 192.168.1.65
function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^:/]+)/)
  return m ? m[1] : ''
}

// 把片段里所有 http://host:port 的 host 替换为指定 IP
function replaceHost(code: string, ip: string): string {
  return code.replace(
    /(https?:\/\/)([A-Za-z0-9.\-]+)(:\d+)/g,
    (_m, p1, _host, p3) => p1 + ip + p3
  )
}

export default observer(function McpConfigModal(props: IModalProps) {
  const [tab, setTab] = useState<TabKey>('stdio')
  const [ipOverride, setIpOverride] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (props.visible) {
      setCopied('')
      setIpOverride(null)
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
  const rawCode = configs ? configs[tab] : ''
  const autoIp = hostOf(store.mcp.url)
  const activeIp = ipOverride || autoIp
  const code = tab === 'http' && ipOverride ? replaceHost(rawCode, ipOverride) : rawCode

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
        {tab === 'http' && store.mcp.lan && store.mcp.lanIps.length > 0 && (
          <div className={Style.lanIps}>
            <span className={Style.lanIpsLabel}>{t('mcpLanIps')}</span>
            {store.mcp.lanIps.map((ip) => (
              <code
                key={ip}
                className={className(
                  Style.lanIp,
                  ip === activeIp && Style.lanIpActive
                )}
                onClick={() => setIpOverride(ip)}
              >
                {ip}
              </code>
            ))}
            <span className={Style.lanIpsHint}>{t('mcpLanIpsHint')}</span>
          </div>
        )}
        {tab !== 'http' && (
          <p className={Style.tip}>{t('mcpConfigRemoteTip')}</p>
        )}
      </div>
    </LunaModal>,
    document.body
  )
})
