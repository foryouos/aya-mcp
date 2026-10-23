import { RefObject, useEffect } from 'react'
import ResizeSensor from 'licia/ResizeSensor'
import Modal from 'luna-modal'
import { t } from '../../common/i18n'

export function useWindowResize(resizeCallback: () => void) {
  useEffect(() => {
    window.addEventListener('resize', resizeCallback)

    return () => {
      window.removeEventListener('resize', resizeCallback)
    }
  }, [])
}

export function useResizeSensor(
  containerRef: RefObject<HTMLElement | null>,
  resizeCallback: () => void
) {
  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    const resizeSensor = new ResizeSensor(containerRef.current)
    resizeSensor.addListener(resizeCallback)

    return () => {
      resizeSensor.destroy()
    }
  }, [])
}

// 更新提示应指向本分支的 Release 页，而非上游官网
export const RELEASES_PAGE = 'https://github.com/foryouos/aya-mcp/releases'

export function useCheckUpdate(url: string = RELEASES_PAGE) {
  useEffect(() => {
    const offUpdateError = main.on('updateError', () => {
      Modal.alert(t('updateErr'))
    })
    const offUpdateNotAvailable = main.on('updateNotAvailable', () => {
      Modal.alert(t('updateNotAvailable'))
    })
    const offUpdateAvailable = main.on('updateAvailable', async () => {
      const result = await Modal.confirm(t('updateAvailable'))
      if (result) {
        main.openExternal(url)
      }
    })
    return () => {
      offUpdateError()
      offUpdateNotAvailable()
      offUpdateAvailable()
    }
  }, [])
}
