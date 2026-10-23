# AYA MCP

基于开源项目 [AYA](https://github.com/liriliri/aya)（作者 surunzi / liriliri，许可证 AGPL-3.0）的二次开发分支。

## 项目简介

AYA 是一款跨平台（Windows / macOS / Linux）的 Android `adb` 桌面工具，提供投屏、文件管理、日志、性能监控、Shell、应用管理等能力。

**本分支（aya-mcp）** 在完整保留上游全部桌面能力的基础上，新增两块能力：

- **MCP 服务**：把 Android 设备能力封装为 50 个 `aya_*` 工具（20 只读 / 30 写），让 CodeBuddy、WorkBuddy、Claude 等 AI 客户端直接用自然语言操控已连接的设备。工具清单与接入方式由 [`page/index.html`](page/index.html) 详细介绍。
- **串口调试面板**：直接接收主板启动日志，自动划分 bootloader / kernel / android 阶段，支持阶段与关键字过滤、暂停、保存会话、波特率自动探测。

当前版本 **v2.1.0**（版本号独立于上游 AYA）。

> 关闭设置中的 MCP 开关时，它就是原版 AYA，使用方式完全不变。

## 目录与代码分布

- `src/`：Electron 源码
  - `src/main/lib/mcp/*`：MCP Server（JSON-RPC 2.0 + SSE）、工具实现、鉴权
  - `src/main/lib/mcp/tools/*`：50 个 `aya_*` 工具（20 只读 / 30 写）
  - `src/main/lib/serial/*`：串口读取、阶段识别、日志缓冲区与会话文件
  - `src/renderer/.../serial/*`：串口调试面板
  - `src/renderer/.../McpConfigModal.tsx`：设置内的 MCP 开关与配置片段
- `script/`：构建与资源脚本（`build` / `pack` / `dev` / `adb` / `scrcpy` / `server` / `mcp`）
- `server/`：Android 端 `aya.dex` 源码（Kotlin，提供 adb 侧能力）
- `page/`：MCP 功能静态宣传页

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

## 许可证

遵循上游 **AGPL-3.0**。本分支在保留上游许可证的前提下新增代码。
