import ScreenGrid from './components/ScreenGrid'
import Toolbar from './components/Toolbar'
import { observer } from 'mobx-react-lite'
import store from './store'
import { useEffect } from 'react'
import { t } from 'common/util'
import { notify } from 'share/renderer/lib/util'

export default observer(function App() {
  const { tiles, lastError } = store
  const title =
    tiles.length > 1
      ? `${t('screencast')} (${tiles.length})`
      : tiles.length === 1
        ? tiles[0].device.name
        : t('screencast')

  useEffect(() => {
    preload.setTitle(title)
  }, [title])

  useEffect(() => {
    if (!lastError) {
      return
    }
    notify(lastError)
    store.clearError()
  }, [lastError])

  return (
    <>
      <Toolbar />
      <ScreenGrid />
    </>
  )
})
