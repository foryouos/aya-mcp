import { observer } from 'mobx-react-lite'
import store, { IScreenTile } from '../store'
import { useEffect, useRef } from 'react'
import Style from './ScreenTile.module.scss'
import endWith from 'licia/endWith'
import { LoadingBar } from 'share/renderer/components/loading'
import { installPackages } from '../../lib/util'
import { t } from 'common/util'
import { isInsideVideoFrame } from '../lib/util'

// 首帧等待上限：设备离线 / reverse 失败 / scrcpy 起不来时，
// getVideo() 会永久 pending，必须兜底，否则这一格一直停在加载中
const FIRST_FRAME_TIMEOUT = 20 * 1000

interface IProps {
  tile: IScreenTile
  // spotlight 布局下正在放大的那一路
  focused?: boolean
  // 工具栏操作的当前目标
  active?: boolean
}

export default observer(function ScreenTile(props: IProps) {
  const { tile, focused, active } = props
  const { device } = tile
  const client = store.getClient(device.id)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!client) {
      return
    }
    // 失败事件可能在组件挂载前就发出了（reverseTcp 秒失败），这里补一次
    if (client.failed) {
      store.setTileError(
        device.id,
        t('screencastFailed', { message: client.failed.message })
      )
      return
    }

    let canceled = false
    let timer: NodeJS.Timeout | undefined

    function fail(err: unknown) {
      if (canceled) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      store.setTileError(device.id, t('screencastFailed', { message }))
    }

    const onError = (err: unknown) => fail(err)
    client.on('error', onError)

    async function start() {
      try {
        const video = await Promise.race([
          client!.getVideo(),
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
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        // 视频流已经在 ScrcpyClient 内部消费，这里只把渲染元素挂到容器上。
        // appendChild 对已挂载的节点是移动操作，界面重挂载也不会出问题
        const element = video.decoder.renderer.element
        if (element.parentElement !== viewportRef.current) {
          viewportRef.current?.appendChild(element)
        }
        store.setTileLoaded(device.id)
      } catch (err) {
        fail(err)
      }
    }
    start()

    // 会话生命周期归 store 所有，这里只负责取消未完成的等待，
    // 避免卸载后回调还去改已被移除的 tile
    return () => {
      canceled = true
      if (timer) {
        clearTimeout(timer)
      }
      client.off('error', onError)
    }
  }, [device.id])

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
    if (apkPaths.length) {
      await installPackages(device.id, apkPaths)
    }
  }

  /**
   * 双击留白区域放大这一路。画面本身的双击会注入两次点击到设备，
   * 所以只有点在 letterbox 黑边上才当成「放大」操作。
   */
  function onViewportDoubleClick(e: React.MouseEvent) {
    if (store.tiles.length < 2) {
      return
    }
    const video = viewportRef.current?.querySelector('video') as
      | HTMLVideoElement
      | null
    if (video && isInsideVideoFrame(video, e.clientX, e.clientY)) {
      return
    }
    store.setFocus(device.id)
  }

  const className = [
    Style.tile,
    active ? Style.active : '',
    focused ? Style.focused : '',
  ]
    .filter((item) => !!item)
    .join(' ')

  return (
    <div
      className={className}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div
        className={Style.viewport}
        ref={viewportRef}
        onDoubleClick={onViewportDoubleClick}
      >
        {tile.loading && <LoadingBar className={Style.loading} />}
        {!tile.loading && !!tile.error && (
          <div className={Style.error}>
            <div className={Style.errorMessage}>{tile.error}</div>
            <button onClick={() => store.reloadTile(device.id)}>
              {t('retry')}
            </button>
          </div>
        )}
        {/* 画面长时间无变化只是个弱提示：设备熄屏或界面静止也是这样，
            所以只放一个不遮挡画面的小图标，点一下重连这一路 */}
        {!tile.error && tile.stalled && (
          <span
            className={`icon-refresh ${Style.stalled}`}
            title={t('screencastStalled')}
            onClick={() => store.reloadTile(device.id)}
          ></span>
        )}
      </div>
      <div
        className={Style.bar}
        onDoubleClick={() => store.setFocus(focused ? '' : device.id)}
      >
        <span
          className={Style.name}
          title={device.id}
          onClick={() => store.setActive(device.id)}
        >
          {device.name}
        </span>
        <span className={Style.actions}>
          <span
            className={`icon-${focused ? 'collapse' : 'expand'}`}
            title={t(focused ? 'collapseScreen' : 'expandScreen')}
            onClick={() => store.setFocus(focused ? '' : device.id)}
          ></span>
          <span
            className="icon-delete"
            title={t('removeScreen')}
            onClick={() => store.removeDevice(device.id)}
          ></span>
        </span>
      </div>
    </div>
  )
})
