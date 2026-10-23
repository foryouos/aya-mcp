import LunaModal from 'luna-modal/react'
import LunaSetting, {
  LunaSettingButton,
  LunaSettingCheckbox,
  LunaSettingHtml,
  LunaSettingNumber,
  LunaSettingSelect,
  LunaSettingTitle,
} from 'luna-setting/react'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import Style from './SettingsModal.module.scss'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { useMemo, useState } from 'react'
import contain from 'licia/contain'
import className from 'licia/className'
import debounce from 'licia/debounce'
import SettingPath from 'share/renderer/components/SettingPath'
import store from '../../store'
import { IModalProps } from 'share/common/types'
import McpConfigModal from './McpConfigModal'

const notifyRequireReload = debounce(() => {
  notify(t('requireReload'), { icon: 'info' })
}, 1000)

type SectionKey = 'general' | 'adb' | 'mcp'

export default observer(function SettingsModal(props: IModalProps) {
  const [section, setSection] = useState<SectionKey>('general')
  const [configVisible, setConfigVisible] = useState(false)
  const applyPort = useMemo(
    () =>
      debounce((port: number) => {
        store.mcp.setPort(port)
      }, 800),
    []
  )

  const sections: Array<{ key: SectionKey; label: string }> = [
    { key: 'general', label: t('appearance') },
    { key: 'adb', label: 'ADB' },
    { key: 'mcp', label: t('mcp') },
  ]

  function onChange(key, val) {
    // MCP 相关配置由主进程托管，走专用 IPC 而不是通用设置存储
    if (contain(['mcpEnabled', 'mcpAllowWrite', 'mcpLan'], key)) {
      if (key === 'mcpEnabled') {
        toggleEnabled(val)
      } else if (key === 'mcpLan') {
        toggleLan(val)
      } else {
        toggleAllowWrite(val)
      }
      return
    }
    if (key === 'mcpPort') {
      applyPort(val)
      return
    }
    if (contain(['language', 'useNativeTitlebar'], key)) {
      notifyRequireReload()
    }
    store.settings.set(key, val)
  }

  async function toggleEnabled(enabled: boolean) {
    const status = await store.mcp.setEnabled(enabled)
    if (enabled && !status.running) {
      notify(t('mcpStartFailed', { error: status.error || '' }), {
        icon: 'error',
      })
      return
    }
    if (enabled) {
      setConfigVisible(true)
    }
  }

  async function toggleAllowWrite(allowWrite: boolean) {
    await store.mcp.setAllowWrite(allowWrite)
    if (allowWrite) {
      notify(t('mcpWriteToolsHint'), { icon: 'info' })
    }
  }

  async function toggleLan(lan: boolean) {
    await store.mcp.setLan(lan)
    if (lan) {
      notify(t('mcpLanHint'), { icon: 'info' })
    }
  }

  async function resetToken() {
    await store.mcp.resetToken()
    notify(t('mcpTokenReset'), { icon: 'success' })
    setConfigVisible(true)
  }

  return createPortal(
    <LunaModal
      title={t('settings')}
      width={520}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.layout}>
        <div className={Style.nav}>
          {sections.map(({ key, label }) => (
            <button
              key={key}
              className={className(Style.navItem, section === key && Style.navActive)}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={Style.pane}>
          {section === 'general' && (
            <LunaSetting className={Style.settings} onChange={onChange}>
              <LunaSettingSelect
                keyName="theme"
                value={store.settings.theme}
                title={t('theme')}
                options={{
                  [t('sysPreference')]: 'system',
                  [t('light')]: 'light',
                  [t('dark')]: 'dark',
                }}
              />
              <LunaSettingSelect
                keyName="language"
                value={store.settings.language}
                title={t('language')}
                options={{
                  [t('sysPreference')]: 'system',
                  ['العربية']: 'ar',
                  English: 'en-US',
                  ['Français']: 'fr',
                  ['Português']: 'pt',
                  ['Español']: 'es',
                  ['Русский']: 'ru',
                  ['Türkçe']: 'tr',
                  ['中文']: 'zh-CN',
                  ['繁體中文']: 'zh-TW',
                }}
              />
              <LunaSettingCheckbox
                keyName="useNativeTitlebar"
                value={store.settings.useNativeTitlebar}
                description={t('useNativeTitlebar')}
              />
            </LunaSetting>
          )}
          {section === 'adb' && (
            <LunaSetting className={Style.settings} onChange={onChange}>
              <SettingPath
                title={t('adbPath')}
                value={store.settings.adbPath}
                onChange={(val) => {
                  notifyRequireReload()
                  store.settings.set('adbPath', val)
                }}
                options={{
                  properties: ['openFile'],
                }}
              />
              <LunaSettingCheckbox
                keyName="killAdbWhenExit"
                value={store.settings.killAdbWhenExit}
                description={t('killAdbWhenExit')}
              />
              <LunaSettingButton
                description={t('restartAya')}
                onClick={() => main.relaunch()}
              />
            </LunaSetting>
          )}
          {section === 'mcp' && (
            <LunaSetting className={Style.settings} onChange={onChange}>
              <LunaSettingCheckbox
                keyName="mcpEnabled"
                value={store.mcp.enabled}
                description={t('mcpEnabled')}
              />
              <LunaSettingCheckbox
                keyName="mcpAllowWrite"
                value={store.mcp.allowWrite}
                description={t('mcpAllowWrite')}
                disabled={!store.mcp.enabled}
              />
              <LunaSettingCheckbox
                keyName="mcpLan"
                value={store.mcp.lan}
                description={t('mcpLan')}
                disabled={!store.mcp.enabled}
              />
              <LunaSettingNumber
                keyName="mcpPort"
                value={store.mcp.port}
                title={t('mcpPort')}
                min={1024}
                max={65535}
                disabled={!store.mcp.enabled}
              />
              <LunaSettingHtml>
                <div className={Style.mcpStatus}>
                  <div className={Style.mcpEndpoint}>
                    <span
                      className={
                        store.mcp.running ? Style.dotRunning : Style.dotStopped
                      }
                    />
                    <span className={Style.mcpUrl}>{store.mcp.url}</span>
                  </div>
                  <div className={Style.mcpMeta}>
                    {store.mcp.running
                      ? `${t('mcpRunning')} · ${t('mcpToolCount', {
                          count: store.mcp.toolCount,
                        })}`
                      : t('mcpNotStarted')}
                  </div>
                  {store.mcp.error ? (
                    <div className={Style.mcpError}>{store.mcp.error}</div>
                  ) : null}
                </div>
              </LunaSettingHtml>
              <LunaSettingHtml>
                <div className={Style.mcpActions}>
                  <button
                    className={Style.mcpAction}
                    onClick={() => setConfigVisible(true)}
                  >
                    {t('mcpViewConfig')}
                  </button>
                  <button className={Style.mcpAction} onClick={resetToken}>
                    {t('mcpResetToken')}
                  </button>
                </div>
              </LunaSettingHtml>
            </LunaSetting>
          )}
        </div>
      </div>
      <McpConfigModal
        visible={configVisible}
        onClose={() => setConfigVisible(false)}
      />
    </LunaModal>,
    document.body
  )
})
