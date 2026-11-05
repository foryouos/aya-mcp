import { observer } from 'mobx-react-lite'
import LunaToolbar, {
  LunaToolbarSeparator,
  LunaToolbarSpace,
} from 'luna-toolbar/react'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import { t } from 'common/util'
import Style from './Toolbar.module.scss'
import store from '../store'
import download from 'licia/download'
import fullscreen from 'licia/fullscreen'
import SettingsModal from './SettingsModal'
import { useState } from 'react'
import { AndroidKeyCode } from '@yume-chan/scrcpy'
import LunaModal from 'luna-modal'
import dateFormat from 'licia/dateFormat'
import AddDeviceModal from './AddDeviceModal'

export default observer(function Toolbar() {
  const [settingsModalVisiable, setSettingsModalVisiable] = useState(false)
  const [addDeviceVisible, setAddDeviceVisible] = useState(false)

  // 工具栏的所有操作都作用于"活动设备"，多设备时由点击设备名条切换
  const tile = store.tile
  const device = tile ? tile.device : null
  const client = device ? store.getClient(device.id) : undefined
  const spotlight =
    !!device &&
    store.layout === 'spotlight' &&
    store.focusDeviceId === device.id
  const multi = store.tiles.length > 1

  async function captureScreenshot() {
    if (!client) {
      return
    }
    const video = await client.getVideo()
    const blob = await video.decoder.snapshot()
    download(blob, `screenshot-${dateFormat('yyyymmddHHMM')}.png`, 'image/png')
  }

  async function toggleFullscreen() {
    if (!client) {
      return
    }
    const video = await client.getVideo()
    fullscreen.toggle(video.decoder.renderer.element.parentElement)
  }

  function inputKey(keyCode: AndroidKeyCode) {
    return () => {
      if (device) {
        main.inputKey(device.id, keyCode)
      }
    }
  }

  async function injectText() {
    if (!client) {
      return
    }
    const text = await LunaModal.prompt(t('inputText'), '')
    if (text) {
      client.setClipboard(text, true)
    }
  }

  function toggleLayout() {
    store.setLayout(store.layout === 'spotlight' ? 'grid' : 'spotlight')
  }

  return (
    <>
      <LunaToolbar className={Style.container}>
        <ToolbarIcon
          icon="add"
          title={t('addDevice')}
          disabled={store.tiles.length === 0}
          onClick={() => setAddDeviceVisible(true)}
        />
        <ToolbarIcon
          icon="grid"
          title={t(store.layout === 'spotlight' ? 'layoutGrid' : 'layoutSpotlight')}
          disabled={!multi}
          state={store.layout === 'spotlight' ? 'hover' : ''}
          onClick={toggleLayout}
        />
        <ToolbarIcon
          icon="expand"
          title={t(spotlight ? 'collapseScreen' : 'expandScreen')}
          disabled={!multi}
          state={spotlight ? 'hover' : ''}
          onClick={() => {
            if (!device) {
              return
            }
            store.setFocus(spotlight ? '' : device.id)
          }}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="power"
          title={t('power')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.Power)}
        />
        <ToolbarIcon
          icon="volume"
          title={t('volumeUp')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.VolumeUp)}
        />
        <ToolbarIcon
          icon="volume-down"
          title={t('volumeDown')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.VolumeDown)}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="back"
          title={t('back')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.AndroidBack)}
        />
        <ToolbarIcon
          icon="circle"
          title={t('home')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.AndroidHome)}
        />
        <ToolbarIcon
          icon="square"
          title={t('appSwitch')}
          disabled={!device}
          onClick={inputKey(AndroidKeyCode.AndroidAppSwitch)}
        />
        <ToolbarIcon
          icon="text"
          title={t('inputText')}
          disabled={!client}
          onClick={injectText}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon={tile && tile.screenOff ? 'screen-on' : 'screen-off'}
          title={t(tile && tile.screenOff ? 'screenOn' : 'screenOff')}
          disabled={!client}
          onClick={() => {
            if (!tile) {
              return
            }
            if (tile.screenOff) {
              store.turnOnScreen()
            } else {
              store.turnOffScreen()
            }
          }}
        />
        <ToolbarIcon
          icon="camera"
          title={t('screenshot')}
          disabled={!client}
          onClick={captureScreenshot}
        />
        <ToolbarIcon
          icon="video-recorder"
          title={t('screenRecording')}
          disabled={!client}
          state={tile && tile.recording ? 'hover' : ''}
          onClick={() => {
            if (!tile) {
              return
            }
            if (tile.recording) {
              store.stopRecording()
            } else {
              store.startRecording()
            }
          }}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="pin"
          title={t('alwaysOnTop')}
          state={store.alwaysOnTop ? 'hover' : ''}
          onClick={() => {
            store.setAlwaysOnTop(!store.alwaysOnTop)
          }}
        />
        <ToolbarIcon
          icon="fullscreen"
          title={t('fullscreen')}
          disabled={!client}
          onClick={toggleFullscreen}
        />
        <LunaToolbarSpace />
        <ToolbarIcon
          icon="setting"
          title={t('settings')}
          disabled={!device}
          onClick={() => setSettingsModalVisiable(true)}
        />
      </LunaToolbar>
      <SettingsModal
        visible={settingsModalVisiable}
        onClose={() => setSettingsModalVisiable(false)}
      />
      <AddDeviceModal
        visible={addDeviceVisible}
        onClose={() => setAddDeviceVisible(false)}
      />
    </>
  )
})
