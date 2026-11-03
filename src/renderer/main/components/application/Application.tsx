import LunaToolbar, {
  LunaToolbarButton,
  LunaToolbarCheckbox,
  LunaToolbarInput,
  LunaToolbarSeparator,
  LunaToolbarSpace,
  LunaToolbarText,
} from 'luna-toolbar/react'
import LunaIconList from 'luna-icon-list/react'
import LunaDataGrid from 'luna-data-grid/react'
import isEmpty from 'licia/isEmpty'
import isNull from 'licia/isNull'
import Style from './Application.module.scss'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import store from '../../store'
import { PannelLoading } from '../common/loading'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import { installPackages } from '../../../lib/util'
import { notify, isFileDrop } from 'share/renderer/lib/util'
import { t } from 'common/util'
import className from 'licia/className'
import endWith from 'licia/endWith'
import find from 'licia/find'
import chunk from 'licia/chunk'
import map from 'licia/map'
import concat from 'licia/concat'
import clone from 'licia/clone'
import LunaModal from 'luna-modal'
import findIdx from 'licia/findIdx'
import PackageInfoModal from './PackageInfoModal'
import ServiceInfoModal from './ServiceInfoModal'
import ServicePanel from './ServicePanel'
import { IPackageInfo, IServiceInfo } from 'common/types'
import defaultIcon from '../../../assets/default-icon.png'
import contextMenu from 'share/renderer/lib/contextMenu'
import dateFormat from 'licia/dateFormat'
import toEl from 'licia/toEl'
import DataGrid from 'luna-data-grid'
import { useWindowResize } from 'share/renderer/lib/hooks'
import fileSize from 'licia/fileSize'
import jsonClone from 'licia/jsonClone'

// IPC 底层（adb shell / 设备端 RPC）若永久挂起，try/finally 不会执行，
// 所以每个请求都必须有超时兜底，否则页面会永久停在 loading。
// 这里必须比主进程侧的超时更长（shell 20s / RPC 90s），
// 让主进程先失败并清掉 singleton 缓存，否则重试会复用同一个 pending 请求
// 主进程侧 getPackages 最坏约 50s（两条 shell 命令各自建连 + 读取），这里留出余量
const GET_PACKAGES_TIMEOUT = 60 * 1000
const GET_PACKAGE_INFOS_TIMEOUT = 120 * 1000

// 设备重启期间 adb 已经上线但系统服务还没起来，第一次必然失败。
// 失败后按指数退避自动重试，累计约 3+6+12+24+48 = 93s，覆盖一次完整重启。
const MAX_AUTO_RETRY = 5
const AUTO_RETRY_BASE_DELAY = 3 * 1000



function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export default observer(function Application() {
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [packageInfo, setPackageInfo] = useState<IPackageInfo | null>(null)
  const [packageInfos, setPackageInfos] = useState<IPackageInfo[]>([])
  const [filter, setFilter] = useState('')
  const [dropHighlight, setDropHighlight] = useState(false)
  const dataGridRef = useRef<DataGrid>(null)
  const [packageInfoModalVisible, setPackageInfoModalVisible] = useState(false)
  const [isOpenEffectAnimating, setIsOpenEffectAnimating] = useState(false)
  const [openEffectStyle, setOpenEffectStyle] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })
  const draggingRef = useRef(0)
  const iconsRef = useRef<any[]>([])
  // 用 ref 做并发锁：isLoading 是异步生效的，连点会放两次请求进来
  const loadingRef = useRef(false)
  // 记录上次失败原因，设备重连（如重启完成）后自动补一次加载
  const loadErrorRef = useRef('')
  const autoRetryRef = useRef(0)
  const autoRetryTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 服务视图
  const [serviceDetail, setServiceDetail] = useState<IServiceInfo | null>(null)
  const [serviceDetailVisible, setServiceDetailVisible] = useState(false)
  const [serviceReloadKey, setServiceReloadKey] = useState(0)

  const { device } = store

  useEffect(() => {
    if (store.application.view !== 'service') {
      refresh()
    }
  }, [])
  useWindowResize(() => dataGridRef.current?.fit())

  useEffect(() => {
    // 设备重启时 adb 会先后推送多次 changeDevice，
    // 若上次加载是失败的，就在设备重新可用后自动重试，不需要用户手动刷新
    return main.on('changeDevice', () => {
      if (loadingRef.current) {
        return
      }
      if (loadErrorRef.current || isEmpty(iconsRef.current)) {
        refresh()
      }
    })
  }, [])

  useEffect(() => {
    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
    }
  }, [])

  async function refresh(packageName?: string, auto = false) {
    // 事件回调里的闭包可能持有旧的 device，这里始终取最新的
    const device = store.device
    if (!device || loadingRef.current) {
      return
    }
    if (!packageName) {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
      // 手动/事件触发的刷新视为一次新的尝试，重置退避计数
      if (!auto) {
        autoRetryRef.current = 0
        setRetryCount(0)
      }
      loadingRef.current = true
      setIsLoading(true)
      setLoadError('')
      setPackageInfos([])
      let loaded = 0
      let packageInfos: any[] = []
      // 图标列表是整体重建的，逐批刷新会反复触发全量 DOM 重建与图片请求
      const flush = (packageInfos: any[]) => {
        iconsRef.current = map(packageInfos, (info) => {
          const style: any = {
            borderRadius: '20%',
          }
          if (!info.enabled) {
            style.filter = 'grayscale(100%)'
          }

          return {
            info: info,
            src: info.icon || defaultIcon,
            name: info.label,
            style,
          }
        })
        setPackageInfos(packageInfos.slice())
      }
      const scheduleAutoRetry = () => {
        if (autoRetryRef.current >= MAX_AUTO_RETRY) {
          autoRetryRef.current = 0
          setRetryCount(0)
          return
        }
        const delay = AUTO_RETRY_BASE_DELAY * Math.pow(2, autoRetryRef.current)
        autoRetryRef.current++
        setRetryCount(autoRetryRef.current)
        autoRetryTimerRef.current = setTimeout(() => {
          autoRetryTimerRef.current = null
          refresh(undefined, true)
        }, delay)
      }
      try {
        const packages = await withTimeout(
          main.getPackages(device.id, store.application.sysPackage),
          GET_PACKAGES_TIMEOUT,
          'getPackages timeout'
        )
        // 每批更小，单批耗时可控，设备刚启动时不会一批就顶到 RPC 超时
        const chunks = chunk(packages, 20)
        for (let i = 0, len = chunks.length; i < len; i++) {
          const chunk = chunks[i]
          packageInfos = concat(
            packageInfos,
            await withTimeout(
              main.getPackageInfos(device.id, chunk),
              GET_PACKAGE_INFOS_TIMEOUT,
              'getPackageInfos timeout'
            )
          )
          loaded = packageInfos.length
          // 每 3 批刷新一次，减少重建次数
          if ((i + 1) % 3 === 0 || i === len - 1) {
            flush(packageInfos)
          }
        }
        loadErrorRef.current = ''
        autoRetryRef.current = 0
        setRetryCount(0)
      } catch (err) {
        if (loaded > 0) {
          flush(packageInfos)
        }
        const message = err instanceof Error ? err.message : String(err)
        loadErrorRef.current = message
        setLoadError(t('loadPackagesFailed', { message }))
        // 已经拿到部分数据时用通知提示，避免把已有列表盖住
        if (loaded > 0) {
          notify(t('loadPackagesFailed', { message }), { icon: 'warning' })
        }
        scheduleAutoRetry()
      } finally {
        // 无论成功还是失败都必须复位，
        // 否则按钮永久禁用、入口守卫挡住重试，页面再也恢复不了
        loadingRef.current = false
        setIsLoading(false)
      }
    } else {
      try {
        const idx = findIdx(
          packageInfos,
          (info) => info.packageName === packageName
        )
        if (idx !== -1) {
          const infos = await withTimeout(
            main.getPackageInfos(device.id, [packageName]),
            GET_PACKAGES_TIMEOUT,
            'getPackageInfos timeout'
          )
          const info = infos[0]
          packageInfos[idx] = info
          const style: any = {
            borderRadius: '20%',
          }
          if (!info.enabled) {
            style.filter = 'grayscale(100%)'
          }
          iconsRef.current[idx] = {
            info: info,
            src: info.icon || defaultIcon,
            name: info.label,
            style,
          }
          iconsRef.current = clone(iconsRef.current)
          setPackageInfos(clone(packageInfos))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        notify(t('loadPackagesFailed', { message }), { icon: 'warning' })
      }
    }
  }

  function switchView(view: 'package' | 'service') {
    if (store.application.view === view) {
      return
    }
    store.application.set('view', view)
    setFilter('')
    if (view === 'package') {
      refresh()
    }
  }

  function switchServiceGroup(group: 'system' | 'app') {
    if (store.application.serviceGroup === group) {
      return
    }
    store.application.set('serviceGroup', group)
    setFilter('')
  }

  function showServiceDetail(service: IServiceInfo) {
    setServiceDetail(service)
    setServiceDetailVisible(true)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropHighlight(false)
    const files = e.dataTransfer.files
    const apkPaths: string[] = []
    for (let i = 0, len = files.length; i < len; i++) {
      const path = preload.getPathForFile(files[i])
      if (!endWith(path, '.apk')) {
        continue
      }
      apkPaths.push(path)
    }
    await install(apkPaths)
  }

  async function install(apkPaths?: string[]) {
    const result = await installPackages(device!.id, apkPaths)
    if (result) {
      refresh()
    }
  }

  function showInfo(packageName: string) {
    const packageInfo = find(
      packageInfos,
      (info) => info.packageName === packageName
    )
    if (packageInfo) {
      setPackageInfo(packageInfo)
      setPackageInfoModalVisible(true)
    }
  }

  function confirmText(key: string, info: any) {
    const ret = t(key, { name: info.label })

    if (info.system) {
      return t('sysPackageTip') + ' ' + ret
    }

    return ret
  }

  async function open(packageName: string) {
    try {
      await main.startPackage(store.device!.id, packageName)
    } catch {
      notify(t('startPackageErr'), { icon: 'error' })
    }
  }

  function onContextMenu(e: PointerEvent, info: IPackageInfo) {
    const device = store.device!

    const template: any[] = [
      {
        label: t('packageInfo'),
        click() {
          showInfo(info.packageName)
        },
      },
      {
        label: t('exportApk'),
        click: async () => {
          const { canceled, filePath } = await main.showSaveDialog({
            defaultPath: `${info.packageName}-${info.versionName}.apk`,
          })
          if (canceled) {
            return
          }
          await main.pullFile(device.id, info.apkPath, filePath)
          notify(t('apkExported', { path: filePath }), {
            icon: 'success',
            duration: 5000,
          })
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('open'),
        click: () => open(info.packageName),
      },
      {
        label: t('stop'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('stopPackageConfirm', info)
          )
          if (result) {
            await main.stopPackage(device.id, info.packageName)
          }
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('disablePackage'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('disablePackageConfirm', info)
          )
          if (result) {
            await main.disablePackage(device.id, info.packageName)
            refresh(info.packageName)
          }
        },
      },
      {
        label: t('enablePackage'),
        click: async () => {
          await main.enablePackage(device.id, info.packageName)
          refresh(info.packageName)
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('clearData'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('clearDataConfirm', info)
          )
          if (result) {
            await main.clearPackage(device.id, info.packageName)
            notify(t('dataCleared'), { icon: 'success' })
            setTimeout(() => refresh(info.packageName), 1000)
          }
        },
      },
      {
        label: t('uninstall'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('uninstallConfirm', info)
          )
          if (result) {
            await main.uninstallPackage(device.id, info.packageName)
            refresh()
          }
        },
      },
    ]

    contextMenu(e, template)
  }

  const isServiceView = store.application.view === 'service'
  const serviceGroup = store.application.serviceGroup

  const serviceView = device ? (
    <ServicePanel
      deviceId={device.id}
      origin={serviceGroup}
      filter={filter}
      reloadKey={serviceReloadKey}
      onDetail={showServiceDetail}
    />
  ) : null

  const applications = (
    <div
      className={Style.applications}
      style={{
        overflowY: store.application.listView ? 'hidden' : 'auto',
      }}
      onDrop={onDrop}
      onDragEnter={() => {
        draggingRef.current++
      }}
      onDragLeave={() => {
        draggingRef.current--
        if (draggingRef.current === 0) {
          setDropHighlight(false)
        }
      }}
      onDragOver={(e) => {
        if (!isFileDrop(e)) {
          return
        }
        e.preventDefault()
        setDropHighlight(true)
      }}
    >
      {store.application.listView ? (
        <LunaDataGrid
          onColumnChange={async () => {
            const columns = dataGridRef.current!.getOption('columns')
            store.application.set('dataGridColumns', jsonClone(columns))
          }}
          onClick={(e: any, node) => {
            showInfo((node.data as any).packageName)
          }}
          onDoubleClick={(e: any, node) => {
            open((node.data as any).packageName)
          }}
          onContextMenu={(e: any, node) => {
            onContextMenu(e, (node.data as any).info)
          }}
          headerContextMenu={true}
          filter={filter}
          columns={columns}
          data={map(packageInfos, (info: IPackageInfo) => {
            return {
              info,
              label: toEl(
                `<span><img src="${info.icon || defaultIcon}" />${
                  info.label
                }</span>`
              ),
              packageName: info.packageName,
              versionName: info.versionName,
              minSdkVersion: info.minSdkVersion,
              targetSdkVersion: info.targetSdkVersion,
              storageUsage: fileSize(
                info.appSize + info.dataSize + info.cacheSize
              ),
              appSize: fileSize(info.appSize),
              dataSize: fileSize(info.dataSize),
              cacheSize: fileSize(info.cacheSize),
              enabled: info.enabled ? t('enabled') : t('disabled'),
              firstInstallTime: dateFormat(
                new Date(info.firstInstallTime),
                'yyyy-mm-dd HH:MM:ss'
              ),
              lastUpdateTime: dateFormat(
                new Date(info.lastUpdateTime),
                'yyyy-mm-dd HH:MM:ss'
              ),
            }
          })}
          selectable={true}
          uniqueId="packageName"
          onCreate={(dataGrid) => {
            dataGridRef.current = dataGrid
            dataGrid.fit()
            dataGrid.setOption('columns', store.application.dataGridColumns)
          }}
        />
      ) : (
        <LunaIconList
          icons={iconsRef.current}
          size={store.application.itemSize}
          filter={filter}
          onClick={(e: any, icon) => {
            const info = (icon.data as any).info
            showInfo(info.packageName)
          }}
          onDoubleClick={(e: any, icon) => {
            const info = (icon.data as any).info
            const container: HTMLElement = icon.container
            const clientRect = container.getBoundingClientRect()
            setOpenEffectStyle({
              left: clientRect.left,
              top: clientRect.top - 60,
              width: clientRect.width,
              height: clientRect.width,
            })
            open(info.packageName)
            setIsOpenEffectAnimating(true)
          }}
          onContextMenu={(e: any, icon) => {
            onContextMenu(e, (icon.data as any).info)
          }}
        />
      )}
      <div
        className={className({
          [Style.openEffect]: true,
          [Style.openEffectAnimation]: isOpenEffectAnimating,
        })}
        style={openEffectStyle}
        onAnimationEnd={() => setIsOpenEffectAnimating(false)}
      />
    </div>
  )

  return (
    <div className="panel-with-toolbar">
      <LunaToolbar className="panel-toolbar">
        <ToolbarIcon
          icon="android"
          title={t('application')}
          state={isServiceView ? '' : 'active'}
          onClick={() => switchView('package')}
        />
        <ToolbarIcon
          icon="processor"
          title={t('service')}
          state={isServiceView ? 'active' : ''}
          onClick={() => switchView('service')}
        />
        <LunaToolbarSeparator />
        <LunaToolbarInput
          keyName="filter"
          value={filter}
          placeholder={t('filter')}
          onChange={(val) => setFilter(val)}
        />
        {isServiceView ? (
          <>
            <LunaToolbarSeparator />
            <LunaToolbarButton
              state={serviceGroup === 'system' ? 'active' : ''}
              onClick={() => switchServiceGroup('system')}
            >
              {t('systemService')}
            </LunaToolbarButton>
            <LunaToolbarButton
              state={serviceGroup === 'app' ? 'active' : ''}
              onClick={() => switchServiceGroup('app')}
            >
              {t('appService')}
            </LunaToolbarButton>
            <LunaToolbarSpace />
            <ToolbarIcon
              icon="refresh"
              title={t('refresh')}
              disabled={!device}
              onClick={() => setServiceReloadKey((key) => key + 1)}
            />
          </>
        ) : (
          <>
            <LunaToolbarCheckbox
              keyName="sysPackage"
              value={store.application.sysPackage}
              label={t('sysPackage')}
              onChange={(val) => {
                store.application.set('sysPackage', val)
                refresh()
              }}
              disabled={isLoading}
            />
            <LunaToolbarSeparator />
            <LunaToolbarText
              text={t('totalPackage', { total: packageInfos.length })}
            />
            <LunaToolbarSpace />
            <ToolbarIcon
              icon="add"
              title={t('install')}
              onClick={() => install()}
              disabled={!device}
            />
            <LunaToolbarSeparator />
            <ToolbarIcon
              icon="zoom-in"
              title={t('zoomIn')}
              disabled={
                store.application.listView ||
                store.application.itemSize > 256 ||
                isEmpty(packageInfos)
              }
              onClick={() => {
                const itemSize = Math.round(store.application.itemSize * 1.2)
                store.application.set('itemSize', itemSize)
              }}
            />
            <ToolbarIcon
              icon="zoom-out"
              title={t('zoomOut')}
              disabled={
                store.application.listView ||
                store.application.itemSize < 32 ||
                isEmpty(packageInfos)
              }
              onClick={() => {
                const itemSize = Math.round(store.application.itemSize * 0.8)
                store.application.set('itemSize', itemSize)
              }}
            />
            <LunaToolbarSeparator />
            <ToolbarIcon
              icon="grid"
              title={t('iconView')}
              state={store.application.listView ? '' : 'hover'}
              onClick={() => {
                if (store.application.listView) {
                  store.application.set('listView', false)
                }
              }}
            />
            <ToolbarIcon
              icon="list"
              title={t('listView')}
              state={store.application.listView ? 'hover' : ''}
              onClick={() => {
                if (!store.application.listView) {
                  store.application.set('listView', true)
                }
              }}
            />
            <LunaToolbarSeparator />
            <ToolbarIcon
              icon="refresh"
              title={t('refresh')}
              disabled={isLoading || !device}
              onClick={() => refresh()}
            />
          </>
        )}
      </LunaToolbar>
      <div
        className={className('panel-body', {
          [Style.highlight]: dropHighlight,
        })}
      >
        {isServiceView ? (
          serviceView
        ) : isLoading && isEmpty(packageInfos) ? (
          <PannelLoading />
        ) : retryCount > 0 && isEmpty(packageInfos) ? (
          <div className={Style.loadError}>
            <div className={Style.loadErrorMessage}>
              {t('waitingDeviceReady')}
            </div>
            <div className={Style.loadErrorHint}>
              {t('autoRetrying', {
                count: retryCount,
                total: MAX_AUTO_RETRY,
              })}
            </div>
            <button onClick={() => refresh()}>{t('retry')}</button>
          </div>
        ) : loadError && isEmpty(packageInfos) ? (
          <div className={Style.loadError}>
            <div className={Style.loadErrorMessage}>{loadError}</div>
            <button onClick={() => refresh()}>{t('retry')}</button>
          </div>
        ) : (
          applications
        )}
      </div>
      {serviceDetail && device && (
        <ServiceInfoModal
          deviceId={device.id}
          service={serviceDetail}
          visible={serviceDetailVisible}
          onClose={() => setServiceDetailVisible(false)}
        />
      )}
      {!isNull(packageInfo) && (
        <PackageInfoModal
          packageInfo={packageInfo}
          visible={packageInfoModalVisible}
          onClose={() => setPackageInfoModalVisible(false)}
        />
      )}
    </div>
  )
})

function sizeCmp(a: string, b: string) {
  return fileSize(a) - fileSize(b)
}

const columns = [
  {
    id: 'label',
    title: t('name'),
    sortable: true,
    weight: 20,
  },
  {
    id: 'packageName',
    title: t('package'),
    sortable: true,
    weight: 25,
  },
  {
    id: 'versionName',
    title: t('version'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'minSdkVersion',
    title: t('minSdkVersion'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'targetSdkVersion',
    title: t('targetSdkVersion'),
    sortable: true,
    visible: false,
    weight: 10,
  },
  {
    id: 'storageUsage',
    title: t('storageUsage'),
    sortable: true,
    comparator: sizeCmp,
    weight: 10,
  },
  {
    id: 'appSize',
    title: t('appSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  {
    id: 'dataSize',
    title: t('dataSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  {
    id: 'cacheSize',
    title: t('cacheSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  {
    id: 'enabled',
    title: t('status'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'firstInstallTime',
    title: t('firstInstallTime'),
    sortable: true,
    visible: false,
    weight: 15,
  },
  {
    id: 'lastUpdateTime',
    title: t('lastUpdateTime'),
    sortable: true,
    visible: false,
    weight: 15,
  },
]
