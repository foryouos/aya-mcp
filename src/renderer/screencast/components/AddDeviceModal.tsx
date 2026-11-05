import LunaModal from 'luna-modal/react'
import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { IDevice } from 'common/types'
import { t } from 'common/util'
import store, { MAX_TILES } from '../store'
import Style from './AddDeviceModal.module.scss'
import { IModalProps } from 'share/common/types'
import each from 'licia/each'

export default observer(function AddDeviceModal(props: IModalProps) {
  const [devices, setDevices] = useState<IDevice[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!props.visible) {
      return
    }
    setSelected([])
    setError('')
    main
      .getDevices()
      .then((result) => setDevices(result))
      .catch(() => setDevices([]))
  }, [props.visible])

  const available: IDevice[] = []
  each(devices, (device) => {
    if (!store.tiles.some((item) => item.device.id === device.id)) {
      available.push(device)
    }
  })

  const remaining = MAX_TILES - store.tiles.length

  function toggle(deviceId: string) {
    const index = selected.indexOf(deviceId)
    if (index >= 0) {
      const next = selected.slice()
      next.splice(index, 1)
      setSelected(next)
      return
    }
    if (selected.length >= remaining) {
      setError(t('screencastMaxTiles', { count: MAX_TILES }))
      return
    }
    setSelected([...selected, deviceId])
  }

  async function onOk() {
    const picked: IDevice[] = []
    each(available, (device) => {
      if (selected.indexOf(device.id) >= 0) {
        picked.push(device)
      }
    })
    for (let i = 0, len = picked.length; i < len; i++) {
      await store.addDevice(picked[i])
    }
    props.onClose()
  }

  // 双击直接投屏这一台，省掉「勾选 + 确定」两步
  async function addOne(device: IDevice) {
    if (store.tiles.length >= MAX_TILES) {
      setError(t('screencastMaxTiles', { count: MAX_TILES }))
      return
    }
    await store.addDevice(device)
    props.onClose()
  }

  return createPortal(
    <LunaModal
      title={t('addDevice')}
      width={420}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.container}>
        <div className={Style.hint}>
          {t('screencastTileLimit', {
            current: store.tiles.length,
            count: MAX_TILES,
          })}
          {' · '}
          {t('doubleClickToAdd')}
        </div>
        <div className={Style.list}>
          {available.length === 0 && (
            <div className={Style.empty}>{t('noMoreDevices')}</div>
          )}
          {available.map((device) => {
            const checked = selected.indexOf(device.id) >= 0
            return (
              <div
                key={device.id}
                className={`${Style.item} ${checked ? Style.checked : ''}`}
                title={t('doubleClickToAdd')}
                onClick={() => toggle(device.id)}
                onDoubleClick={() => addOne(device)}
              >
                <span
                  className={`icon-${checked ? 'check' : 'phone'}`}
                  aria-hidden="true"
                ></span>
                <span className={Style.name}>{device.name}</span>
                <span className={Style.id}>{device.id}</span>
              </div>
            )
          })}
        </div>
        {!!error && <div className={Style.error}>{error}</div>}
        <div className={Style.footer}>
          <button onClick={props.onClose}>{t('cancel')}</button>
          <button disabled={!selected.length} onClick={onOk}>
            {t('ok')}
          </button>
        </div>
      </div>
    </LunaModal>,
    document.body
  )
})
