# AYA MCP

基于开源项目 [AYA](https://github.com/liriliri/aya)（作者 surunzi / liriliri，许可证 AGPL-3.0）的二次开发分支。

## 项目简介

AYA 是一款跨平台（Windows / macOS / Linux）的 Android `adb` 桌面工具，提供投屏、文件管理、日志、性能监控、Shell、应用管理等能力。

**本分支（aya-mcp）** 在完整保留上游全部桌面能力的基础上，新增两块能力：

- **MCP 服务**：把 Android 设备能力封装为 73 个 `aya_*` 工具（29 只读 / 44 写），让 CodeBuddy、WorkBuddy、Claude 等 AI 客户端直接用自然语言操控已连接的设备。工具清单与接入方式由 [`page/index.html`](page/index.html) 详细介绍。
- **串口调试面板**：直接接收主板启动日志，自动划分 bootloader / kernel / android 阶段，支持阶段与关键字过滤、暂停、保存会话、波特率自动探测。

当前版本 **v2.1.2**（版本号独立于上游 AYA）。

> 关闭设置中的 MCP 开关时，它就是原版 AYA，使用方式完全不变。

## 性能对比：同板实测 vs uiautomator2

在 **同一台设备（RK3576 / Android 14）**、同一界面（设置首页与搜索页）上交替测量：u2 侧用 Python 3.12 + `uiautomator2`（atx-agent + uiautomator stub），aya 侧直连 MCP HTTP 端点（`POST /mcp` + Bearer Token，不经过 AI 客户端），每项 10–20 次取 avg / p50 / p95。

| 用例 | uiautomator2 | AYA MCP | 差异 |
| --- | --- | --- | --- |
| UI 层级（各自默认口径） | 309.2 ms / 93,484 B（XML） | **131.5 ms / 3,936 B**（紧凑 JSON） | 2.35× 快 / 23.7× 小 |
| 原始 XML（同口径） | 309.2 ms / 93,484 B | **179.5 ms / 83,678 B** | 1.72× 快 / 10% 小 |
| 点击（坐标） | 180.2 ms | **90.8 ms** | 1.98× 快 |
| 滑动（300 ms 动作时长） | 1160.2 ms | **390.0 ms** | 2.98× 快 |
| 文本写入 | 252.8 ms（send_keys）/ 475.7 ms（set_text） | **92.6 ms**（`ACTION_SET_TEXT`） | 2.7–5.1× 快 |
| 截图 | 145.3 ms / 6,220,800 B（PNG） | 161.5 ms / **14,256 B**（JPEG 900px） | 耗时相当，体积 436× 小 |
| 按控件定位点击 | 937.3 ms | **338.2 ms**（快照过期时需重新 dump） | 2.77× 快 |
| 按中文文本定位点击 | 匹配失败（Windows 版 u2 请求编码问题） | **62.4 ms** | — |

差异来自三处实现选择：

1. **注入路径**：aya 走常驻 UiAutomation 的 `injectInputEvent`（一次 binder）；u2 经 atx-agent jsonrpc，300 ms 的滑动被拆成 10 步插值、每步一次 HTTP 往返。
2. **定位方式**：aya 一次 dump 解析出紧凑节点表并缓存快照（`snapshotId` 60 s），命中缓存时不再 dump；u2 每次 `d(...)` 都是一次节点查找 + 隐式等待。
3. **传输体积**：aya 在设备端把层级压成紧凑 JSON、截图压成 JPEG；u2 返回整棵 XML 与原始 PNG。

对 AI 场景更关键的是**上下文成本**：一次层级读取 aya ≈1.2k tokens，u2 ≈30k tokens；截图回传体积相差 436 倍。另外 aya 具备 u2 没有的能力：无障碍事件订阅（`aya_ui_watch`）、事件驱动等待（`aya_wait_for` 返回 `mode:"events"`）、串口启动日志、录屏投屏控制、屏幕适配与性能统计。

### 什么时候仍然该用 uiautomator2

- **上百步的固定回归**：写一次 Python 循环跑完，不经过模型往返；aya 逐工具调用会付出 N 次模型往返。
- **需要断言、数据驱动与 CI 报告**：pytest 是它的主场。
- **需要图像处理 / OCR 等 Python 生态**：aya 只做设备控制这一层。

### 一个必须知道的限制

aya 的常驻 UiAutomation 与 uiautomator2 的 UiAutomation **争抢同一个无障碍连接槽位**，同一台设备上不能同时使用：aya 设备端在跑时 u2 启动会报 `IllegalStateException: UiAutomation not connected`，停掉 aya 设备端服务后 u2 立即可用。

复现方式（基准脚本在 `script/bench/`）：

```bat
pip install uiautomator2
python -m uiautomator2 init
REM 测 u2 前：adb shell pkill -f io.liriliri.aya.Server
python script/bench/bench_u2.py --out tmp-bench-u2.json
REM 测 aya 前：停掉 u2 的 atx-agent（python -c "import uiautomator2 as u2; u2.connect('SERIAL').stop_atx_agent()"）
node script/bench/bench_aya.mjs --out tmp-bench-aya.json
```

完整数据与测试方法见 [`TEST_REPORT.md`](TEST_REPORT.md) 第 8 节。

## 目录与代码分布

- `src/`：Electron 源码
  - `src/main/lib/mcp/*`：MCP Server（JSON-RPC 2.0 + SSE）、工具实现、鉴权
  - `src/main/lib/mcp/tools/*`：73 个 `aya_*` 工具（29 只读 / 44 写）
  - `src/main/lib/serial/*`：串口读取、阶段识别、日志缓冲区与会话文件
  - `src/renderer/.../serial/*`：串口调试面板
  - `src/renderer/.../McpConfigModal.tsx`：设置内的 MCP 开关与配置片段
- `script/`：构建与资源脚本（`build` / `pack` / `dev` / `adb` / `scrcpy` / `server` / `mcp`）
  - `script/bench/`：与 uiautomator2 的同板性能对比脚本（`bench_u2.py` / `bench_aya.mjs`）
- `server/`：Android 端 `aya.dex` 源码（Kotlin，提供 adb 侧能力）
- `page/`：MCP 功能静态宣传页（`index.html` 概览、`tools.html` 完整工具清单）

## 编译环境

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 与 npm | 构建与依赖管理（推荐 LTS） |
| Windows + PowerShell 5.1+ | 运行 `dev.bat` / `release.bat` 一键脚本 |
| git | 拉取仓库资源 / 子模块 |
| JDK 17 | 仅当 `resources/aya.dex` 缺失、需现场用 Gradle 编译 Android 端时使用 |
| Android SDK platform-tools | 可选；脚本会从 `D:\Android\SDK`、`%LOCALAPPDATA%\Android\Sdk` 或 `ANDROID_HOME` 自动复制 `adb` 到 `resources/` |

> macOS / Linux 没有 `.bat` 入口，可直接用 `npm run dev` + `electron .`（参考 `script/dev.ps1` 的步骤）。

## 快速开始（开发调试）

```bat
dev.bat          # 一键：环境自检 → 依赖/资源准备 → 编译 → 启动调试
npm run debug    # 等价的 npm 方式（PowerShell）
```

首次运行会自动安装依赖、准备 `resources/adb` 与 `resources/aya.dex`，之后再次运行会跳过已就绪的步骤。

## 编译 / 打包脚本

`package.json` 中的脚本及其作用如下：

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 原生开发方式：`concurrently` 同时 watch 编译 main / preload，并启动 Vite dev server（渲染进程 8080 端口，支持热更新） |
| `npm run dev:main` / `dev:preload` / `dev:renderer` | 单独 watch 编译主进程 / 预加载脚本 / 渲染进程 |
| `npm run build` | 生产构建全部产物（main + preload + renderer） |
| `npm run build:main` / `build:preload` / `build:renderer` | 单独生产构建某一部分 |
| `npm run pack` | 使用 electron-builder 打包为可分发的安装包 |
| `npm run pack:mas-dev` / `pack:mas` / `pack:appx` | 分别打包 macOS 开发签名版 / macOS App Store 版 / Windows AppX 版 |
| `npm run release` | 等价于 `build` + `pack`，产出完整发布包（默认不自动上传） |
| `release.bat` | Windows 一键发布：切到仓库根目录后执行 `npm run release`，结束暂停便于查看产物 |
| `npm run adb` / `scrcpy` / `server` | 准备 `resources/adb` / `resources/scrcpy.jar`，或现场编译 `resources/aya.dex` |
| `npm run format` | Prettier 格式化源码与配置文件 |
| `npm run lint` | ESLint 检查 `src/**` |
| `npm run gen:theme` | 根据 `src/common/theme.json` 重新生成主题 token（`theme.ts` / `theme.scss`） |
| `npm run gen:icon` | 由 `src/renderer/icon/` 重新生成图标 CSS |
| `npm run gen:pb` | 由 `server/.../Wire.proto` 重新生成 protobuf 的 JS / TS 定义 |
| `npm run start` | 用已构建产物以 `--inspect` 启动 Electron，便于调试主进程 |
| `npm run debug`（`debug:prod`） | 经 `script/dev.ps1` 启动带 Node inspector / CDP 的调试会话 |

### dev.bat / dev.ps1 常用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Mode` | `dev` | `dev`（Vite 热更新）/ `prod`（生产编译） |
| `-Clean` | 关 | 编译前删除 `dist/` |
| `-SkipInstall` | 关 | 跳过 npm 依赖检查 / 安装 |
| `-SkipAssets` | 关 | 跳过 `resources/adb`、`resources/aya.dex` 准备 |
| `-KillRunning` | 关 | 自动结束占用单实例锁的 AYA |
| `-InspectPort` / `-CdpPort` | `9229` / `9222` | 主进程 / 渲染进程调试端口 |

## 更新发布

应用内的「检查更新」默认读取 **GitHub Releases**（`foryouos/aya-mcp`）。需要把产物上传到仓库 Release 时，设置环境变量后发布：

```bat
set AYA_PUBLISH=1
npm run release
```

（需具备 `GH_TOKEN` 且对仓库有推送权限。）

## 调试

- 渲染进程：应用内 `Ctrl+Shift+I`，或浏览器打开 `chrome://inspect` 连接 `localhost:9222`。
- 主进程：`chrome://inspect` 连接 `localhost:9229`（Node inspector，可断点）。
- dev 模式渲染代码改动即时热更新；主进程 / preload 改动需重跑脚本（或用 `npm run dev:main` / `dev:preload` 单独 watch 后重启 Electron）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动后窗口立刻消失、无报错 | 已有 AYA 占用单实例锁，执行 `dev.bat -KillRunning` |
| 窗口空白 / 一直加载 | dev server 未就绪或 8080 端口被占用 |
| 改了主进程代码但行为没变 | 主进程需重新编译并重启，重跑 `dev.bat` |
| 投屏提示 `scrcpy: Aborted` | 缺少 `resources/scrcpy.jar`，执行 `npm run scrcpy` |
| adb 找不到设备 | 确认 `resources/adb/adb.exe` 存在且 `adb devices` 有输出 |
| 安装依赖很慢 | 脚本默认使用 npmmirror 的 Electron 镜像，可自行设置 `ELECTRON_MIRROR` |
| 想同时用 AYA MCP 与 uiautomator2 | 二者争抢同一个无障碍连接，同一设备上不能同时运行：aya 设备端在跑时 u2 会报 `UiAutomation not connected`，需先停掉另一侧（见上文「性能对比」） |

## 许可证

遵循上游 **AGPL-3.0**。本分支在保留上游许可证的前提下新增代码。
