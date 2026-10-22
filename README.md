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

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动后窗口立刻消失、无报错 | 已有 AYA 占用单实例锁，执行 `dev.bat -KillRunning` |
| 窗口空白 / 一直加载 | dev server 未就绪或端口被占用，检查 8080 是否被其他进程监听 |
| 改了主进程代码但行为没变 | 主进程需重新编译并重启，重跑 `dev.bat` |
| 投屏提示 `scrcpy: Aborted` | 缺少 `resources/scrcpy.jar`，执行 `npm run scrcpy` |
| adb 找不到设备 | 确认 `resources/adb/adb.exe` 存在，`adb devices` 有输出 |
| 安装依赖很慢 | 脚本默认使用 `https://npmmirror.com/mirrors/electron/` 镜像，可自行设置 `ELECTRON_MIRROR` |

## 其它常用命令

```bash
npm run dev        # 原生的 concurrent watch 开发方式（需自行启动 electron）
npm run build      # 生产构建全部产物
npm run pack       # 打包安装包
npm run format     # 代码格式化
npm run lint       # ESLint 检查
```

macOS / Linux 无 `dev.bat`，可参考 `script/dev.ps1` 的步骤直接使用 `npm run dev` 加 `electron .`。
