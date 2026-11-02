import { observer } from 'mobx-react-lite'
import store from '../store'
import { useEffect, useRef, useState } from 'react'
import Style from './Screencast.module.scss'
import endWith from 'licia/endWith'
import { LoadingBar } from 'share/renderer/components/loading'
import { installPackages } from '../../lib/util'
import { t } from 'common/util'

// 首帧等待上限：设备离线 / reverse 失败 / scrcpy 起不来时，
// getVideo() 会永久 pending，必须兜底，否则窗口一直停在加载中
const FIRST_FRAME_TIMEOUT = 20 * 1000

export default observer(function Screencast() {
  const { device, scrcpyClient } = store
  const screenContainerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let canceled = false
    let timer: NodeJS.Timeout | undefined

    preload.setTitle(device.name)

    function fail(err: unknown) {
      if (canceled) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      setError(t('screencastFailed', { message }))
      setIsLoading(false)
    }

    async function start() {
      try {
        const video = await Promise.race([
          scrcpyClient.getVideo(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('video stream timeout')),
              FIRST_FRAME_TIMEOUT
            )
          }),
        ])
        if (canceled) {
          return
        }
        video.stream.pipeTo(video.decoder.writable).catch(fail)
        screenContainerRef.current?.appendChild(video.decoder.renderer.element)
        setIsLoading(false)
      } catch (err) {
        fail(err)
      }
    }
    start()

    return () => {
      canceled = true
      if (timer) {
        clearTimeout(timer)
      }
      scrcpyClient.destroy()
    }
  }, [])

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()

    const files = e.dataTransfer.files
    const apkPaths: string[] = []
    for (let i = 0, len = files.length; i < len; i++) {
      const path = preload.getPathForFile(files[i])
      if (!endWith(path, '.apk')) {
        continue
      }
      apkPaths.push(path)
    }
    await installPackages(device.id, apkPaths)
  }

  return (
    <div
      ref={screenContainerRef}
      className={Style.container}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {isLoading && <LoadingBar />}
      {!isLoading && !!error && (
        <div className={Style.error}>
          <div className={Style.errorMessage}>{error}</div>
          <button onClick={() => main.restartScreencast()}>{t('retry')}</button>
        </div>
      )}
    </div>
  )
})
