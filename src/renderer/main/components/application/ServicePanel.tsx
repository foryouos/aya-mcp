import { observer } from 'mobx-react-lite'
import LunaDataGrid from 'luna-data-grid/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from 'common/util'
import { useResizeSensor, useWindowResize } from 'share/renderer/lib/hooks'
import { IServiceInfo, ServiceKind } from 'common/types'
import Style from './ServicePanel.module.scss'

type ServiceGroup = 'all' | 'hal' | 'java' | 'vendor'
type ViewMode = 'service' | 'process'

interface IProps {
  deviceId: string
  origin: 'system' | 'app'
  filter: string
  reloadKey: number
  onDetail: (service: IServiceInfo) => void
}

const LOAD_TIMEOUT = 90 * 1000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

const KIND_LABEL: { [key in ServiceKind]: string } = {
  'aidl-hal': 'AIDL HAL',
  'hidl-hal': 'HIDL HAL',
  'native-binder': 'Native Binder',
  'java-system': 'Java SystemService',
  'app-service': 'App Service',
}

function formatRss(kb: number): string {
  if (!kb) {
    return '—'
  }
  if (kb >= 1024 * 1024) {
    return `${(kb / 1024 / 1024).toFixed(2)} GB`
  }
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`
  }

  return `${kb} KB`
}

function domainOf(selinux: string): string {
  if (!selinux) {
    return '—'
  }
  const matched = /^u:r:([^:]+):/.exec(selinux)

  return matched ? matched[1] : selinux
}

function statusText(status: string): string {
  if (status === 'running') {
    return t('running')
  }
  if (status === 'lazy') {
    return t('lazyService')
  }
  if (status === 'dead') {
    return t('dead')
  }

  return '—'
}

/** 进程视图的类型列：同一进程里可能混着多种服务，按数量从多到少列出 */
function formatKindSummary(kinds: Partial<Record<ServiceKind, number>>): string {
  return (Object.keys(kinds) as ServiceKind[])
    .sort((a, b) => (kinds[b] || 0) - (kinds[a] || 0))
    .map((kind) => `${KIND_LABEL[kind]} ×${kinds[kind] || 0}`)
    .join('  ')
}

interface IProcessGroup {
  pid: number
  processName: string
  selinux: string
  status: string
  rssKb: number
  kinds: Partial<Record<ServiceKind, number>>
  services: IServiceInfo[]
}

export default observer(function ServicePanel(props: IProps) {
  const { deviceId, origin, filter, reloadKey, onDetail } = props
  const [services, setServices] = useState<IServiceInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [group, setGroup] = useState<ServiceGroup>('all')
  // 进程视图：先按 PID 聚合，点进某个进程再看它内部的全部服务
  const [mode, setMode] = useState<ViewMode>('service')
  const [activePid, setActivePid] = useState<number | null>(null)
  const dataGridRef = useRef<any>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 窗口尺寸变化（含进入/退出全屏）时 DataGrid 需要重算视口高度，
  // 否则只会按旧高度渲染，下方的行看不到也不会滚动出来。
  // 容器尺寸监听覆盖侧栏折叠、面板切换等不触发窗口 resize 的情况
  useWindowResize(() => dataGridRef.current?.fit())
  useResizeSensor(bodyRef, () => dataGridRef.current?.fit())

  useEffect(() => {
    let canceled = false
    setLoading(true)
    setError('')
    setServices([])

    withTimeout(
      main.getServices(deviceId),
      LOAD_TIMEOUT,
      'getServices timeout'
    )
      .then((rows) => {
        if (!canceled) {
          setServices(rows)
        }
      })
      .catch((err) => {
        if (!canceled) {
          const message = err instanceof Error ? err.message : String(err)
          setError(t('loadServicesFailed', { message }))
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false)
        }
      })

    return () => {
      canceled = true
    }
  }, [deviceId, reloadKey])

  // 切换视图 / 设备 / 刷新时都要退出进程详情，否则会停在过期数据上
  useEffect(() => {
    setActivePid(null)
  }, [mode, origin, reloadKey])

  const inProcessDetail = mode === 'process' && activePid !== null

  const serviceRows = useMemo(() => {
    const keyword = filter.trim().toLowerCase()

    return services
      .filter((service) => {
        if (service.origin !== origin) {
          return false
        }
        if (activePid !== null && (service.pid || 0) !== activePid) {
          return false
        }
        // 进入某个进程后展示它的全部服务，不再按 HAL/Java/Vendor 过滤
        if (activePid === null) {
          if (group === 'hal' && !service.kind.endsWith('-hal')) {
            return false
          }
          if (group === 'java' && service.kind !== 'java-system') {
            return false
          }
          if (group === 'vendor' && !service.vendor) {
            return false
          }
        }
        if (!keyword) {
          return true
        }

        return `${service.name} ${service.descriptor} ${service.processName} ${service.pid}`
          .toLowerCase()
          .includes(keyword)
      })
      .map((service) => ({
        service,
        id: service.id,
        name: service.name,
        descriptor:
          service.origin === 'app'
            ? service.packageName
            : service.descriptor || service.name,
        pid: service.pid || '—',
        processName: service.processName || '—',
        kind: KIND_LABEL[service.kind],
        selinux: domainOf(service.selinux),
        status: statusText(service.status),
        rss: formatRss(service.rssKb),
      }))
  }, [services, origin, group, filter, activePid])

  const processRows = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    const map = new Map<number, IProcessGroup>()

    services.forEach((service) => {
      if (service.origin !== origin) {
        return
      }
      if (keyword) {
        const text =
          `${service.name} ${service.pid} ${service.processName}`.toLowerCase()
        if (!text.includes(keyword)) {
          return
        }
      }

      const key = service.pid || 0
      let entry = map.get(key)
      if (!entry) {
        entry = {
          pid: key,
          processName: '',
          selinux: '',
          status: service.status,
          rssKb: 0,
          kinds: {},
          services: [],
        }
        map.set(key, entry)
      }

      entry.services.push(service)
      entry.kinds[service.kind] = (entry.kinds[service.kind] || 0) + 1
      // 同一个进程的指标对所有服务都一样，取第一个有值的即可
      if (!entry.processName && service.processName) {
        entry.processName = service.processName
      }
      if (!entry.selinux && service.selinux) {
        entry.selinux = service.selinux
      }
      if (!entry.rssKb && service.rssKb) {
        entry.rssKb = service.rssKb
      }
      if (entry.status !== 'running' && service.status === 'running') {
        entry.status = 'running'
      }
    })

    return Array.from(map.values())
      .sort((a, b) => b.services.length - a.services.length)
      .map((entry) => ({
        id: `pid:${entry.pid}`,
        // 点开进程详情时用它定位
        pid: entry.pid,
        pidLabel: entry.pid > 0 ? entry.pid : '—',
        name:
          entry.processName ||
          (entry.pid > 0 ? `pid ${entry.pid}` : t('unknownProcess')),
        kindSummary: formatKindSummary(entry.kinds),
        selinuxLabel: domainOf(entry.selinux),
        statusLabel: statusText(entry.status),
        rss: formatRss(entry.rssKb),
        count: entry.services.length,
      }))
  }, [services, origin, filter])

  // 进程详情标题用的进程名（不受当前过滤条件影响）
  const activeProcessName = useMemo(() => {
    if (activePid === null) {
      return ''
    }
    const found = services.find(
      (service) => (service.pid || 0) === activePid && service.processName
    )

    return found ? found.processName : ''
  }, [services, activePid])

  const groups: Array<{ key: ServiceGroup; label: string }> = [
    { key: 'all', label: t('allServices') },
    { key: 'hal', label: t('halServices') },
    { key: 'java', label: t('javaServices') },
    { key: 'vendor', label: t('vendorServices') },
  ]

  // 进程列表显示聚合行，点进某个进程后回到服务列
  const isProcessList = mode === 'process' && activePid === null
  const data = isProcessList ? processRows : serviceRows
  const gridColumns = isProcessList ? processColumns : columns

  return (
    <div className={Style.container}>
      <div className={Style.toolbar}>
        {inProcessDetail ? (
          <>
            <button className={Style.tag} onClick={() => setActivePid(null)}>
              ← {t('backToProcesses')}
            </button>
            <span className={Style.breadcrumb}>
              {activeProcessName || t('unknownProcess')} · PID{' '}
              {activePid === null ? '—' : activePid} · {t('serviceCount')}{' '}
              {serviceRows.length}
            </span>
          </>
        ) : (
          <>
            {groups.map((item) => (
              <button
                key={item.key}
                className={group === item.key ? Style.tagActive : Style.tag}
                onClick={() => setGroup(item.key)}
              >
                {item.label}
              </button>
            ))}
            <button
              className={mode === 'process' ? Style.tagActive : Style.tag}
              onClick={() => setMode(mode === 'process' ? 'service' : 'process')}
            >
              {t('processView')}
            </button>
          </>
        )}
        <span className={Style.count}>
          {isProcessList
            ? t('totalProcess', { total: processRows.length })
            : t('totalService', { total: serviceRows.length })}
        </span>
      </div>
      <div className={Style.body} ref={bodyRef}>
        {error ? (
          <div className={Style.tip}>{error}</div>
        ) : loading ? (
          <div className={Style.tip}>{t('loading')}</div>
        ) : (
          <LunaDataGrid
            key={`${mode}-${activePid ?? 'all'}`}
            onClick={(e: any, node) => {
              const row = node.data as any
              if (isProcessList) {
                setActivePid(row.pid as number)
                return
              }
              onDetail(row.service)
            }}
            headerContextMenu={true}
            columns={gridColumns}
            data={data}
            selectable={true}
            uniqueId="id"
            onCreate={(dataGrid) => {
              dataGridRef.current = dataGrid
              dataGrid.fit()
            }}
          />
        )}
      </div>
    </div>
  )
})

const columns = [
  { id: 'name', title: t('serviceName'), sortable: true, weight: 26 },
  { id: 'pid', title: 'PID', sortable: true, weight: 7 },
  { id: 'processName', title: t('processName'), sortable: true, weight: 16 },
  { id: 'kind', title: t('serviceType'), sortable: true, weight: 12 },
  { id: 'selinux', title: 'SELinux', sortable: true, weight: 16 },
  { id: 'status', title: t('status'), sortable: true, weight: 8 },
  { id: 'rss', title: t('processRss'), sortable: true, weight: 8 },
  { id: 'descriptor', title: t('serviceInterface'), sortable: true, weight: 22 },
]

const processColumns = [
  { id: 'pidLabel', title: 'PID', sortable: true, weight: 8 },
  { id: 'name', title: t('processName'), sortable: true, weight: 24 },
  { id: 'selinuxLabel', title: 'SELinux', sortable: true, weight: 18 },
  { id: 'kindSummary', title: t('serviceType'), sortable: true, weight: 24 },
  { id: 'statusLabel', title: t('status'), sortable: true, weight: 8 },
  { id: 'rss', title: t('processRss'), sortable: true, weight: 10 },
  { id: 'count', title: t('serviceCount'), sortable: true, weight: 8 },
]
