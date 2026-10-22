# AYA 一键编译运行

本仓库提供 `script/dev.ps1`（入口 `dev.bat`），用于一条命令完成 **环境自检 → 依赖/资源准备 → 编译 → 启动调试**，无需手工依次执行 `npm install`、`vite build`、`electron`。

## 前置要求

| 依赖 | 说明 |
| --- | --- |
| Windows + PowerShell 5.1+ | 脚本运行环境 |
| Node.js | 已在 PATH 中，需要 npm |
| git | 用于初始化 `src/share` 子模块 |
| JDK 17 | 仅当 `resources/aya.dex` 缺失、需现场编译 server 时使用 |
| Android SDK platform-tools | 可选；会从 `D:\Android\SDK`、`%LOCALAPPDATA%\Android\Sdk` 或 `ANDROID_HOME` 自动复制 adb |

## 快速开始

```bat
:: 双击运行，或在命令行执行
dev.bat

:: npm 方式
npm run debug
```

首次运行会自动安装依赖、拉取子模块、准备运行资源，之后再次运行会跳过已就绪的步骤。

## 运行模式

| 模式 | 编译方式 | 窗口加载 |
| --- | --- | --- |
| `dev`（默认） | main / preload 以 `--mode=development` 编译（dev 构建标识生效） | `http://localhost:8080/`，支持热更新 |
| `prod` | main / preload / renderer 全部生产编译 | `dist/renderer/index.html` |

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Mode` | `dev` | `dev` / `prod` |
| `-Clean` | 关 | 编译前删除 `dist/` |
| `-SkipInstall` | 关 | 不检查、不安装 npm 依赖 |
| `-SkipAssets` | 关 | 不准备 `resources/adb`、`resources/aya.dex` |
| `-KillRunning` | 关 | 自动结束占用单实例锁的 AYA（含已安装版） |
| `-InspectPort` | `9229` | 主进程 Node inspector 端口 |
| `-CdpPort` | `9222` | 渲染进程 CDP 端口 |

示例：

```bat
dev.bat -Clean
dev.bat -KillRunning
dev.bat -Mode prod
dev.bat -Mode prod -SkipInstall
powershell -NoProfile -ExecutionPolicy Bypass -File script\dev.ps1 -InspectPort 9230 -CdpPort 9223
```

## 脚本流程

1. **检查工具链**：Node 版本、`node_modules`（缺失时带 `ELECTRON_MIRROR` 安装）、`src/share` 子模块。
2. **准备运行资源**：`resources/adb/*`（adb、AdbWinApi.dll 等）、`resources/aya.dex`（缺失时调用 `gradlew :server:assembleRelease` 生成），缺 `resources/scrcpy.jar` 时给出提示。
3. **处理单实例锁**：dev 构建的 userData 固定为 `%APPDATA%\AYA`，与已安装版共用锁。检测到运行中的 AYA 时默认中止并给出提示，加 `-KillRunning` 自动关闭。
4. **编译主进程 / 预加载**：`vite build --mode=development|production --config vite.main.ts|vite.preload.ts`。
5. **渲染进程**：dev 模式启动 Vite dev server（8080）并轮询到 HTTP 200 就绪；prod 模式执行 `vite build`。
6. **启动**：`electron --inspect=9229 --remote-debugging-port=9222 .`，脚本同步等待应用退出。
7. **清理**：应用退出或构建失败时自动关闭 Vite dev server，不残留 8080 端口占用。

## 调试

- 渲染进程：应用内 `Ctrl+Shift+I`，或浏览器打开 `chrome://inspect` 连 `localhost:9222`。
- 主进程：`chrome://inspect` 连 `localhost:9229`（Node inspector，可断点调试）。
- dev 模式下渲染代码改动即时热更新；**主进程 / preload 改动需重新执行脚本**（或用 `npm run dev:main`、`npm run dev:preload` 单独 watch 后重启 Electron）。

## MCP 服务（AI 客户端控制设备）

AYA 内置一个只监听 `127.0.0.1` 的 MCP 服务，把设备能力以 `aya_*` 工具暴露给 CodeBuddy / WorkBuddy 等 AI 客户端，省去"写脚本 → 运行 → 解析输出"的往返。

**开启方式**：设置 → MCP → 勾选"启用 MCP 服务"。开启后自动弹出配置片段，复制到客户端即可；服务随应用启动自动拉起，端口默认 `7788`。

**工具清单**（共 42 个，16 只读 / 26 写）：

设备与画面：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_list_devices` | 只读 | 列出在线设备，标出 AYA 当前选中设备 |
| `aya_device_info` | 只读 | 机型、系统版本、分辨率、CPU/内存/电量摘要 |
| `aya_screencap` | 只读 | 截图（默认缩放到 900px 宽，返回 `scale`） |
| `aya_ui_dump` | 只读 | UI 层级树，节点带 `bounds` / `center` / 全局索引 `i` |
| `aya_current_app` | 只读 | 前台包名与 pid |
| `aya_set_font_scale` | 写 | 设置系统字体缩放（0.5-2.0），返回改动前后的值 |

交互：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_tap` | 写 | 坐标、`nodeIndex`+`snapshotId`、或 `text`/`id`/`desc` 选择器；默认点完立即回传新界面 |
| `aya_tap_text` | 写 | `aya_tap{text}` 的语义化快捷方式 |
| `aya_batch` | 写 | 一次调用串行执行最多 20 个动作，最后统一回传界面 |
| `aya_wait_for` | 只读 | 轮询等待控件出现/消失，命中或超时都返回当前界面 |
| `aya_swipe` | 写 | 滑动，`duration` 默认 300ms |
| `aya_key` | 写 | `back`/`home`/`enter`/`recent`/`volume_up` 等按键 |
| `aya_text` | 写 | 仅可打印 ASCII，中文走 `aya_shell` + 输入法 |

应用管理：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_list_packages` | 只读 | 包名列表（apk 路径、是否系统应用），可关键字过滤/仅第三方 |
| `aya_app_info` | 只读 | 版本号、sdk、安装/更新时间、启用状态、运行状态与 pid |
| `aya_start_app` | 写 | 启动 Launcher Activity |
| `aya_stop_app` | 写 | `am force-stop` 强杀进程 |
| `aya_clear_app_data` | 写 | `pm clear` 清空数据与缓存，不可撤销 |
| `aya_set_app_enabled` | 写 | 启用/禁用应用（`pm enable` / `pm disable-user`） |
| `aya_install_app` | 写 | 安装本机 apk（覆盖安装保留数据） |
| `aya_uninstall_app` | 写 | 卸载应用（含数据） |

性能与进程：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_performance` | 只读 | CPU 各核负载/温度、内存占用、电量、开机时长、前台帧率 |
| `aya_list_processes` | 只读 | 运行中的进程名与 pid，可关键字过滤 |

文件：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_list_dir` | 只读 | 列目录（目录优先，含大小/时间/mime） |
| `aya_stat_path` | 只读 | 路径属性：是否存在、文件/目录、大小、权限 |
| `aya_pull_file` | 写 | 设备 → 本机，省略目标路径时存到临时目录 `aya-mcp/` |
| `aya_push_file` | 写 | 本机 → 设备 |
| `aya_delete_path` | 写 | 删除文件/目录，目录必须显式 `recursive: true` |
| `aya_make_dir` | 写 | `mkdir -p` |
| `aya_rename_path` | 写 | 重命名/移动 |

日志与命令：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_logcat` | 只读 | 日志快照，按级别/标签/关键字过滤，返回结构化条目 |
| `aya_clear_logcat` | 写 | 清空日志缓冲区 |
| `aya_shell` | 写 | adb shell，30s 超时，输出截断 20000 字符 |

端口映射与 WebView：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_list_ports` | 只读 | 列出 `adb forward` / `adb reverse` 的全部映射 |
| `aya_add_port` | 写 | 新增映射，`direction: forward`（主机→设备）或 `reverse`（设备→主机） |
| `aya_remove_port` | 写 | 按 `local`（forward）/ `remote`（reverse）移除，`all: true` 清空该方向 |
| `aya_list_webviews` | 只读 | 列出应用内 WebView 的调试页面（title/url/devtoolsFrontendUrl） |

端口端点支持 `8080`、`tcp:8080`、`localabstract:<name>` 三种写法，省略 `tcp:` 会自动补齐；WebView 调试默认取前台应用，也可显式传 `pid`，内部自动 `adb forward` 并访问 `/json`。

录屏与投屏：

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `aya_start_recording` | 写 | 设备端 `screenrecord` 后台开录，可设时长（≤180s）、码率、分辨率 |
| `aya_stop_recording` | 写 | 停止录制并把视频拉回本机，返回本机路径、大小、时长 |
| `aya_recording_status` | 只读 | 是否在录、已录时长、剩余时长、设备端文件大小 |
| `aya_cast_window` | 写 | 打开 / 关闭 / 重启 AYA 投屏窗口 |
| `aya_cast_settings` | 写 | 读取或修改投屏码率、最大边长，`restart: true` 立即生效 |

录屏是「开录 → 操作 → 停录」三步：`aya_start_recording` 立刻返回，后续 `aya_tap` / `aya_batch` 照常执行，最后 `aya_stop_recording` 触发 SIGINT 让设备正常收尾（直接杀进程会留下损坏的 mp4）。

写工具默认隐藏，需在设置中勾选"允许写入操作"；桥接脚本通过 SSE 收到 `notifications/tools/list_changed` 后通知客户端热刷新，客户端不支持热更新时重连即可。

**典型组合**：验证某个操作是否报错，先 `aya_clear_logcat`，执行操作，再 `aya_logcat{level:'E'}`；排查应用异常退出一律先 `aya_app_info` 看 `running`/`pid`，再决定 `aya_start_app` 重启；需要把崩溃日志带回本机就 `aya_pull_file` 拉 `/sdcard/` 下的文件。

**点击定位**：`aya_ui_dump` 返回的 `i` 是未过滤完整树的 DFS 前序号，过滤只减少返回节点、不改变 `i`。把 `nodeIndex` 和 `snapshotId` 一起传给 `aya_tap` 才能精确点击；快照 60s 过期，任何输入类工具执行后立即失效，返回 `STALE_SNAPSHOT` 时重新 dump。同名控件用 `index`（从 0 开始）选择，越界返回 `AMBIGUOUS_MATCH` 并附候选列表。

**时序敏感操作（控件会自动隐藏）**：视频播放器控制栏、Toast、下拉菜单往往只停留 1-3 秒，而模型在两次工具调用之间的思考延迟就可能超过这个窗口——「先 `aya_tap`，再 `aya_ui_dump`」经常只读到控件已隐藏后的界面。三种做法按需要选：

- `aya_tap` 默认 `withUi: true`：点完立刻（`settle` 默认 120ms）抓一帧，返回 `ui.nodes`（可直接配合 `ui.snapshotId` 继续点）与 `ui.appeared` / `ui.disappeared`（相对点击前新增/消失的控件）。一次往返完成「点击 + 观察」；只要点击结果时传 `withUi: false`。
- `aya_batch`：把「点击 → 等待 → 再点击」合成一次调用，服务端连续执行，中间不经过模型，彻底避开思考延迟。某步失败会停在该步（`failedAt` + `error`），但依然返回当前界面便于纠正。
- `aya_wait_for`：等控件出现或消失（`gone: true`），命中立即返回，超时也带回当前界面的可交互节点，比反复 `aya_ui_dump` 省调用。

注意 `withUi` 抓的是**点击后**的界面，返回的 `snapshotId` 与 `nodeIndex` 属于新快照，不要再用点击前的 `snapshotId` 去点。

**两种接入方式**：

- `stdio`（推荐）：客户端以 `AYA.exe` 附带 `--url` / `--token` 启动 `resources/mcp/aya-mcp-stdio.cjs` 桥接脚本，脚本把 stdio 上的 JSON-RPC 转发到本机 HTTP 服务。
- `http`：直接把 `http://127.0.0.1:7788/mcp` 与 `Authorization: Bearer <token>` 配给客户端；HTTP 无状态，切换写权限后需重新 `tools/list`。

令牌首次开启服务时生成并持久化，配置片段内含令牌，泄露后可在设置中点"重置访问令牌"。服务不监听外网、校验 `Origin`、限制请求体 2MB。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动后窗口立刻消失、无报错 | 已有 AYA 占用单实例锁，执行 `dev.bat -KillRunning` |
| 窗口空白 / 一直加载 | dev server 未就绪或端口被占用，检查 8080 是否被其他进程监听 |
| 改了主进程代码但行为没变 | 主进程需重新编译并重启，重跑 `dev.bat` |
| 投屏提示 `scrcpy: Aborted` | 缺少 `resources/scrcpy.jar`，执行 `npm run scrcpy` |
| adb 找不到设备 | 确认 `resources/adb/adb.exe` 存在，`adb devices` 有输出 |
| 安装依赖很慢 | 脚本默认使用 `https://npmmirror.com/mirrors/electron/` 镜像，可自行设置 `ELECTRON_MIRROR` |
| MCP 开关打不开、提示端口被占用 | 7788 已被告占用，改端口后重试；设置项里会直接显示错误原因 |
| 客户端只看到 16 个只读工具 | 未勾选"允许写入操作"，勾选后重连 MCP 服务（或等待 `tools/list_changed` 热更新） |
| `aya_tap` 返回 `STALE_SNAPSHOT` | 快照 60s 过期或中间执行过输入类工具，重新 `aya_ui_dump` 再点 |
| 点开播放器控制栏后 `aya_ui_dump` 读不到 | 控件已自动隐藏，改用 `aya_tap` 的 `withUi`（默认开）或 `aya_batch` 在同一次调用内完成点击与观察 |
| `withUi` 返回 `ui.nodes` 为空 | 视频/游戏画面是 SurfaceView，uiautomator 读不到节点，改用 `aya_screencap` 从截图判断 |
| `aya_start_recording` 提示"设备已在录屏中" | 上一次没正常停止，`kill -2` 收尾或等 180s 自动结束；`aya_recording_status` 可看到 pid |
| `aya_stop_recording` 返回文件为空 | 录制时长过短（不足 1s）或设备 `screenrecord` 不可用，加大 `timeLimit` 后重试 |

## 其它常用命令

```bash
npm run dev        # 原生的 concurrent watch 开发方式（需自行启动 electron）
npm run build      # 生产构建全部产物
npm run pack       # 打包安装包
npm run format     # 代码格式化
npm run lint       # ESLint 检查
```

macOS / Linux 无 `dev.bat`，可参考 `script/dev.ps1` 的步骤直接使用 `npm run dev` 加 `electron .`。
