export interface IDevice {
  id: string
  name: string
  serialno: string
  androidVersion: string
  sdkVersion: string
  type: 'emulator' | 'device' | 'offline' | 'unauthorized' | 'unknown'
}

export interface IAvd {
  id: string
  name: string
  abi: string
  sdkVersion: string
  memory: number
  internalStorage: number
  resolution: string
  folder: string
  pid: number
}

export interface IPackageInfo {
  icon: string
  label: string
  enabled: boolean
  packageName: string
  versionName: string
  apkPath: string
  apkSize: number
  system: boolean
  firstInstallTime: number
  lastUpdateTime: number
  minSdkVersion?: number
  targetSdkVersion?: number
  dataSize: number
  cacheSize: number
  appSize: number
  signatures: string[]
}

export interface IFileStat {
  size?: number
  mtime: Date
  directory: boolean
  mode: string
}

export interface IFile extends IFileStat {
  name: string
  mime?: string
}

export interface IWebview {
  title: string
  url: string
  devtoolsFrontendUrl: string
  webSocketDebuggerUrl: string
  faviconUrl?: string
}

export interface IProcess {
  name: string
  pid: string
}

export interface IMcpStatus {
  running: boolean
  enabled: boolean
  lan: boolean
  port: number
  url: string
  lanIps: string[]
  allowWrite: boolean
  toolCount: number
  rev: number
  error?: string
}

export interface IMcpConfigs {
  port: number
  token: string
  stdio: string
  node: string
  http: string
}

export enum TransferType {
  Upload,
  Download,
}

export type IpcGetFps = (deviceId: string, pkg: string) => Promise<number>
export type IpcGetDevices = () => Promise<IDevice[]>
export type IpcSetScreencastAlwaysOnTop = (alwaysOnTop: boolean) => void
export type IpcListForwards = (
  deviceId: string
) => Promise<Array<{ local: string; remote: string }>>
export type IpcListReverses = IpcListForwards
export type IpcForward = (
  deviceId: string,
  local: string,
  remote: string
) => void
export type IpcReverse = (
  deviceId: string,
  remote: string,
  local: string
) => void
export type IpcDumpWindowHierarchy = (deviceId: string) => Promise<string>
export type IpcGetPackageInfos = (
  deviceId: string,
  packageNames: string[]
) => Promise<IPackageInfo[]>
export type IpcGetAvds = (forceRefresh?: boolean) => Promise<IAvd[]>
export type IpcStartAvd = (avdId: string) => Promise<void>
export type IpcStopAvd = IpcStartAvd
export type IpcWipeAvdData = (avdId: string) => Promise<void>
export type IpcPairDevice = (
  host: string,
  port: number,
  password: string
) => Promise<void>
export type IpcCreateShell = (deviceId: string) => Promise<string>
export type IpcWriteShell = (sessionId: string, data: string) => void
export type IpcResizeShell = (
  sessionId: string,
  cols: number,
  rows: number
) => void
export type IpcKillShell = (sessionId: string) => void
export type IpcScreencap = (deviceId: string) => Promise<string>
export type IpcOpenLogcat = (deviceId: string) => Promise<string>
export type IpcCloseLogcat = (logcatId: string) => Promise<void>
export type IpcPauseLogcat = IpcCloseLogcat
export type IpcResumeLogcat = IpcCloseLogcat
export type IpcInputKey = (deviceId: string, keyCode: number) => Promise<void>
export type IpcInputTap = (
  deviceId: string,
  x: number,
  y: number
) => Promise<string>
export type IpcInputSwipe = (
  deviceId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration?: number
) => Promise<string>
export type IpcInputText = (deviceId: string, text: string) => Promise<string>
export type IpcMcpGetStatus = () => Promise<IMcpStatus>
export type IpcMcpSetEnabled = (enabled: boolean) => Promise<IMcpStatus>
export type IpcMcpSetAllowWrite = (allowWrite: boolean) => Promise<IMcpStatus>
export type IpcMcpSetPort = (port: number) => Promise<IMcpStatus>
export type IpcMcpSetLan = (lan: boolean) => Promise<IMcpStatus>
export type IpcMcpGetConfigs = () => Promise<IMcpConfigs>
export type IpcMcpResetToken = IpcMcpGetConfigs
export type IpcReverseTcp = (
  deviceId: string,
  remote: string
) => Promise<number>
export type IpcStartScrcpy = (deviceId: string, args: string[]) => Promise<void>
export type IpcConnectDevice = (host: string, port?: number) => Promise<void>
export type IpcDisconnectDevice = IpcConnectDevice
export type IpcMoveFile = (
  deviceId: string,
  src: string,
  dest: string
) => Promise<void>
export type IpcStatFile = (deviceId: string, path: string) => Promise<IFileStat>
export type IpcReadDir = (deviceId: string, path: string) => Promise<IFile[]>
export type IpcCreateDir = (deviceId: string, path: string) => Promise<void>
export type IpcDeleteDir = IpcCreateDir
export type IpcDeleteFile = IpcCreateDir
export type IpcOpenFile = IpcCreateDir
export type IpcPushFile = (
  deviceId: string,
  src: string,
  dest: string
) => Promise<void>
export type IpcPullFile = (
  deviceId: string,
  src: string,
  dest: string
) => Promise<void>
export type IpcEnablePackage = (deviceId: string, pkg: string) => Promise<void>
export type IpcDisablePackage = IpcEnablePackage
export type IpcGetPackages = (
  deviceId: string,
  system?: boolean
) => Promise<string[]>
export type IpcInstallPackage = (
  deviceId: string,
  apkPath: string
) => Promise<void>
export type IpcUninstallPackage = (
  deviceId: string,
  pkg: string
) => Promise<void>
export type IpcStartPackage = (deviceId: string, pkg: string) => Promise<void>
export type IpcStopPackage = IpcStartPackage
export type IpcClearPackage = IpcStartPackage
export type IpcGetTopPackage = (deviceId: string) => Promise<{
  name: string
  pid: number
}>
export type IpcGetWebviews = (
  deviceId: string,
  pid: number
) => Promise<IWebview[]>
export type IpcGetProcesses = (deviceId: string) => Promise<IProcess[]>
export type IpcGetFileUrl = (
  deviceId: string,
  path: string,
  port?: number
) => Promise<string>

export type SerialSource = 'bootloader' | 'kernel' | 'android' | 'other'

export interface ISerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  vendorId?: string
  productId?: string
  friendlyName?: string
}

export interface ISerialLine {
  seq: number
  time: number
  source: SerialSource
  text: string
  // true 表示这一行是主机发给设备的数据，用于在日志里回显发送内容
  tx?: boolean
}

export interface ISerialStatus {
  open: boolean
  path: string
  baudRate: number
  dataBits: number
  stopBits: number
  parity: string
  paused: boolean
  sessionId: string
  startedAt: number
  lines: number
  seq: number
  dropped: number
  bytes: number
  txBytes: number
  logFile: string
  logFiles: string[]
  logFileSize: number
  maxLines: number
  error: string
}

export interface ISerialQuery {
  // 0 表示不限制（导出场景）
  lines?: number
  keyword?: string
  regex?: boolean
  source?: SerialSource | 'all'
  fromSeq?: number
  toSeq?: number
  // true 时返回命中的最后 N 行（查看最新日志），否则返回最早 N 行
  latest?: boolean
}

export interface ISerialQueryResult {
  total: number
  matched: number
  returned: number
  truncated: boolean
  lines: ISerialLine[]
  status: ISerialStatus
}

export interface ISerialData {
  sessionId: string
  lines: ISerialLine[]
  dropped: number
  bytes: number
  logFileSize: number
}

export type IpcSerialListPorts = () => Promise<ISerialPortInfo[]>
export type IpcSerialOpen = (
  path: string,
  baudRate: number
) => Promise<ISerialStatus>
export type IpcSerialClose = () => Promise<ISerialStatus>
export type IpcSerialStatus = () => Promise<ISerialStatus>
export type IpcSerialSetPaused = (paused: boolean) => Promise<ISerialStatus>
export type IpcSerialClear = () => Promise<ISerialStatus>
export type IpcSerialQuery = (query: ISerialQuery) => Promise<ISerialQueryResult>
export type IpcSerialSave = (
  mode: 'view' | 'session',
  query?: ISerialQuery
) => Promise<string>
export type IpcSerialWrite = (
  data: string,
  newline?: boolean | 'crlf' | 'lf' | 'none'
) => Promise<void>
export type IpcSerialSetBaud = (baudRate: number) => Promise<ISerialStatus>
export type IpcSerialDetectBaud = () => Promise<{
  rate: number
  detected: boolean
}>
export type IpcSerialWait = (
  pattern: string,
  options?: { regex?: boolean; timeout?: number }
) => Promise<{
  matched: boolean
  waited: number
  line: ISerialLine | null
}>

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface IUpdateAsset {
  name: string
  size: number
  url: string
}

export interface IUpdateRelease {
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
  assets: IUpdateAsset[]
}

export interface IUpdateState {
  phase: UpdatePhase
  currentVersion: string
  // 当前平台对应的安装包；没有对应产物时为空，只能前往发布页手动下载
  asset: IUpdateAsset | null
  release: IUpdateRelease | null
  hasUpdate: boolean
  progress: number
  received: number
  total: number
  downloadedPath: string
  error: string
  checkedAt: number
}

export type IpcCheckUpdate = (silent?: boolean) => Promise<IUpdateState>
export type IpcGetUpdateState = () => Promise<IUpdateState>
export type IpcDownloadUpdate = () => Promise<IUpdateState>
export type IpcCancelUpdateDownload = () => Promise<IUpdateState>
export type IpcInstallUpdate = () => Promise<IUpdateState>
export type IpcShowUpdateWindow = () => void
