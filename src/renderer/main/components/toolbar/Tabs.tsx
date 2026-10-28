import LunaTab, { LunaTabItem } from 'luna-tab/react'
import { observer } from 'mobx-react-lite'
import map from 'licia/map'
import contain from 'licia/contain'
import filter from 'licia/filter'
import { useEffect } from 'react'
import { t } from 'common/util'
import Style from './Tabs.module.scss'
import store from '../../store'

const ALL_PANELS = [
  'overview',
  'file',
  'application',
  'process',
  'performance',
  'shell',
  'layout',
  'screenshot',
  'logcat',
  'serial',
  'webview',
]

// 带 adb 的 Linux 工控主板（RK3568/RK3576 等）只有 shell/sync 通道：
// 应用管理走 pm/am，布局走 uiautomator，截图走 screencap，WebView 走 Android 的
// devtools socket 命名，这些在 Linux 上都不存在，直接隐藏避免点了报错。
// 日志面板保留：Linux 走 journalctl/dmesg 后端。
const ANDROID_ONLY_PANELS = ['application', 'layout', 'screenshot', 'webview']

function panelAvailable(panel: string, platform?: string) {
  if (platform !== 'linux') {
    return true
  }

  return !contain(ANDROID_ONLY_PANELS, panel)
}

export default observer(function Panels() {
  const platform = store.device?.platform
  const panels = filter(ALL_PANELS, (panel) => panelAvailable(panel, platform))

  // 当前选中的面板被隐藏时（切到 Linux 设备）自动回到概览
  useEffect(() => {
    if (!panelAvailable(store.panel, platform)) {
      store.selectPanel('overview')
    }
  }, [store.panel, platform])

  const tabItems = map(panels, (panel) => {
    return (
      <LunaTabItem
        key={panel}
        id={panel}
        title={t(panel)}
        selected={panel === store.panel}
      />
    )
  })

  return (
    <LunaTab
      className={Style.container}
      height={31}
      onSelect={(panel) => store.selectPanel(panel)}
    >
      {tabItems}
    </LunaTab>
  )
})
