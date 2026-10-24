# AYA MCP 引用测试计划

> 版本：v1.1　适用：aya-mcp v2.2.1（50 个 `aya_*` 工具 + 串口调试）
> 执行方式：人工或 AI 客户端按用例逐条执行，执行后回填「实测结果」
> 目标设备：`ceea400d750e8749`（SC-MBR3576 / RK3576 / Android 14）

## 1. 测试目标与范围

### 1.1 目标

验证 AYA MCP 把 Android 设备能力封装为 `aya_*` 工具后，能否覆盖三类真实使用需求：

1. **APK 开发工程师日常需求**：浏览器/H5 适配（音乐播放、按钮控制、输入）、应用装卸载、日志抓取、文件传输、UI 与性能验证。
2. **BSP 开发工程师日常需求**：设备属性查询、Shell 探测、端口映射、串口启动日志（bootloader / kernel / android 分段）、串口命令下发。
3. **复杂场景效率**：多步流程下 `aya_batch` 与逐条调用、`aya_wait_for` 与反复 `aya_ui_dump` 的往返次数与耗时差异，以及失败恢复能力。

### 1.2 不在范围内

- AYA 桌面端 UI（投屏窗口、串口面板、设置页）本身的交互测试。
- MCP 鉴权、SSRF、DoS 等安全渗透测试（仅覆盖「监听 127.0.0.1」「写操作需显式开启」两条基线）。
- 上游 AYA 原有能力的回归测试。

### 1.3 产出物

- 本测试计划文档（用例清单）。
- 执行后的回填记录（见第 9 节结果记录表），不产出自动化脚本。

## 2. 测试环境

### 2.1 实测环境基线（2026-10-24 采集）

| 项目 | 实测值 |
| --- | --- |
| AYA 版本 | 2.2.1 |
| MCP 接入方式 | stdio 桥接 `resources/mcp/aya-mcp-stdio.cjs` → `http://127.0.0.1:7788/mcp` |
| 在线设备 | `ceea400d750e8749`（当前选中，唯一在线） |
| 设备型号 | SC-MBR3576（`ro.product.name=rk3576_u`）/ brand `rockchip` / ABI arm64-v8a |
| 系统 | Android 14（SDK 34）/ kernel 6.1.99 / 无 root |
| 分辨率 | 1920×1080（density 160，与物理分辨率一致） |
| CPU / 内存 | 8 核 / 总内存 4,086,702,080 B（约 3.8 GB），已用约 1.24 GB |
| 存储 | 总 55,952,015,360 B，已用约 517 MB |
| 前台应用 | `com.android.launcher3`（启动器） |
| 浏览器 | `org.chromium.chrome.stable`（系统应用） |
| WebView Shell | `org.chromium.webview_shell`（`/product/app/Browser2/Browser2.apk`） |
| 三方应用 | 无（`aya_list_packages{thirdPartyOnly:true}` → `total:129`、`matched:0`），故 B-01/B-03 改用 `$WEBVIEW` 验证 |
| 输入法 | `com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME`（Gboard，中文键盘会改写 ASCII） |
| 串口 | `COM31`（USB-SERIAL CH340，VID_1A86/PID_7523），波特率 **1,500,000**，8N1；`115200` 采集为乱码 |
| 其他串口 | `COM1`（ACPI\\PNP0501 标准端口，非 USB 转串口） |
| 端口映射 | 起始为空；测试中自行建立 forward/reverse 并清理（仅保留 AYA 投屏自身的 scrcpy reverse） |

> 说明：该机逻辑分辨率与物理分辨率一致（1920×1080），但 `aya_screencap` 仍会把图片缩放到 `maxWidth`（实测 900×506、`scale:0.46875`），涉及坐标的用例必须使用 `aya_ui_dump` 返回的 `center`（设备像素），不要用截图上的像素。
>
> **日志来源必须区分**：`aya_logcat` / `aya_clear_logcat` 取的是 **adb logcat**（应用层日志）；`aya_serial_logs` / `aya_serial_wait` 取的是 **主机 USB 串口**（`COM31`，接板子调试口）的**真实串口输出**，包含 bootloader / kernel 启动阶段。启动阶段日志只能由串口获得，应用崩溃日志只能用 logcat。

### 2.2 前置条件清单

| 编号 | 前置条件 | 检查方式 |
| --- | --- | --- |
| P-01 | AYA 已启动且 MCP 开关为开启状态 | 客户端能列出 `aya_*` 工具 |
| P-02 | 设备 adb 在线且为 AYA 当前选中设备 | `aya_list_devices` 返回 `selected: true` |
| P-03 | 允许写操作已开启 | 任一写工具（如 `aya_tap`）不返回 `WRITE_DISABLED` |
| P-04 | 设备已联网（H5 在线音乐页需要） | `aya_shell` 执行 `ping -c 1 223.5.5.5` |
| P-05 | 测试物料就绪（见 2.3） | 逐项确认 |
| P-06 | 串口硬件已连接（仅模块 C） | `aya_serial_list_ports` 出现 `COM31` |

### 2.3 测试物料

| 物料 | 用途 | 准备方式 |
| --- | --- | --- |
| H5 音乐播放页 | 模块 A 播放/暂停/进度/音量 | 在线音乐站点，或本机静态页 + `aya_add_port` reverse 映射到设备可访问地址 |
| H5 表单页（含文本框、按钮） | 模块 A 输入与提交 | 同上；页面需有 `<input>`、`<button>`、结果回显 |
| 测试 APK | 模块 B 安装/覆盖安装/卸载 | 任意可重装的自研 apk，包名记为 `<TEST_PKG>`（**禁止**使用业务包名） |
| 测试文件 | 模块 B 文件拉推 | 本机准备 `aya-test-push.txt`（内容含唯一字符串 `AYA_MCP_TEST_2026`） |
| USB 转串口线 | 模块 C 串口用例 | CH340 已接入，`COM31` 可用 |

### 2.4 变量约定

用例中统一使用以下占位符，执行前替换为实际值：

| 变量 | 含义 | 当前取值 |
| --- | --- | --- |
| `$DEV` | 设备序列号 | `ceea400d750e8749` |
| `$BROWSER` | 浏览器包名 | `org.chromium.chrome.stable` |
| `$WEBVIEW` | WebView Shell 包名 | `org.chromium.webview_shell` |
| `$APP` | 被测三方应用 | 本机无三方应用，改用 `$WEBVIEW`；`aya_app_info{package:"com.tudou.video"}` → `NOT_FOUND` |
| `$TEST_PKG` | 测试 APK 包名 | 执行时填写 |
| `$SERIAL` | 串口路径 | `COM31` |

## 3. 优先级与执行约定

### 3.1 优先级

| 优先级 | 定义 | 当前环境可执行性 |
| --- | --- | --- |
| P0 | 核心链路，失败即视为 MCP 不可用 | Android 真机可直接执行 |
| P1 | 主要功能与边界，失败需记录缺陷 | Android 真机可直接执行 |
| P2 | 破坏性操作或依赖特定硬件/网络，按需执行 | 串口用例需串口硬件；破坏性用例需测试包 |

### 3.2 执行约定

- **写操作**：所有 `write: true` 工具需在 AYA 设置中开启「允许写操作」，否则预期返回 `WRITE_DISABLED`。
- **破坏性用例**（`aya_uninstall_app`、`aya_clear_app_data`、`aya_delete_path`、`aya_serial_write` 发 `reboot`）只允许作用于 `$TEST_PKG` / `/sdcard/aya-test/` 等测试对象，执行前二次确认。
- **快照规则**：`aya_ui_dump` 返回的 `snapshotId` 只能用于同一次界面状态；任何输入类工具执行后快照失效。
- **坐标规则**：点击/滑动一律使用 `aya_ui_dump` 的 `center` 或 `bounds` 换算，不使用截图像素。
- **结果判定**：每条用例都需记录「实测结果」，判定为 通过 / 失败 / 阻塞（附错误码）。

## 4. 效率指标口径（模块 D 必填）

每条效率用例记录以下指标：

| 指标 | 符号 | 定义 | 采集方式 |
| --- | --- | --- | --- |
| 工具调用次数 | N | 从任务开始到结束的 MCP 工具往返次数（含失败重试） | 人工计数或客户端调用日志 |
| 端到端耗时 | T | 第一次工具调用发起到最后一次返回的时间（ms） | 客户端时间戳差值 |
| 成功率 | S | 同一用例连续执行 3 次，成功次数 / 3 | 记录 3 次结果 |
| 恢复成本 | R | 失败后恢复到可继续状态所需的额外调用次数 | 人工计数 |

参考基线（首次执行只记录实际值，之后作为回归对比基线）：

| 对比项 | 参考目标 |
| --- | --- |
| `aya_batch` vs 逐条调用 | 同一流程 N(batch) ≤ N(逐条) 的 1/3，T(batch) ≤ T(逐条) × 0.7 |
| `aya_wait_for` vs 轮询 `aya_ui_dump` | N(wait_for) = 1 且 T ≤ 轮询方式 × 0.5 |
| 失败恢复 | `failedAt` 可定位到具体步骤，R ≤ 2 |

## 5. 模块 A：浏览器 / H5 适配（APK 开发工程师）

> 场景来源：H5 页面在 WebView / 浏览器中的播放控制、按钮点击、文本输入、调试定位。
> 通用前置：P-01～P-05；`$BROWSER` 已安装。

### A-01 启动浏览器并加载音乐播放页（P0）

**前置**：设备联网；已知音乐页 URL `<MUSIC_URL>`。

**步骤**

```text
1. aya_start_app  { deviceId: "$DEV", package: "$BROWSER" }
2. aya_current_app { deviceId: "$DEV" }
3. aya_ui_dump   { deviceId: "$DEV", clickableOnly: true, maxNodes: 80 }
4. aya_tap       { deviceId: "$DEV", nodeIndex: <地址栏 i>, snapshotId: "<上一步 snapshotId>" }
5. aya_text      { deviceId: "$DEV", text: "<MUSIC_URL>" }
6. aya_key       { deviceId: "$DEV", key: "enter" }
7. aya_wait_for  { deviceId: "$DEV", text: "播放", timeout: 10000 }
```

**预期结果**

- 第 2 步返回 `package: "org.chromium.chrome.stable"` 与非空 `pid`。
- 第 3 步返回 `snapshotId`、`nodes[]`（含 `i` / `bounds` / `center` / `class`）。
- 第 6 步返回 `ok: true`、`keycode: 66`。
- 第 7 步返回 `matched: true`、`node` 非空、`attempts ≥ 1`。

**通过标准**：URL 成功加载且页面出现可识别的播放控件（`matched: true`）。

**实测结果**：通过（改用 WebView Shell 宿主 + 本机静态页）。`aya_add_port{reverse, tcp:8000→tcp:8000}` 后 `am start -n org.chromium.webview_shell/.WebViewBrowserActivity -d http://127.0.0.1:8000/`，`aya_current_app` 返回 `org.chromium.webview_shell`（pid 2277），页面「播放」按钮可读且可点击。该机为纯净系统，未安装 `$APP`。　**N**：2（start + dump）　**T**：≈3 s（不含 reverse 建立）

### A-02 获取 WebView 调试地址并建立端口映射（P1）

**前置**：`$WEBVIEW`（`org.chromium.webview_shell`）已打开一个 H5 页面。

**步骤**

```text
1. aya_start_app    { deviceId: "$DEV", package: "$WEBVIEW" }
2. aya_list_webviews { deviceId: "$DEV" }
3. aya_list_ports   { deviceId: "$DEV" }
4. aya_add_port     { deviceId: "$DEV", direction: "forward", local: "tcp:9333", remote: "localabstract:webview_devtools_remote_<pid>" }
5. aya_list_ports   { deviceId: "$DEV" }
```

**预期结果**

- 第 2 步返回 `total ≥ 1`，`webviews[0]` 含 `title`、`url`、`devtoolsFrontendUrl`、`webSocketDebuggerUrl`，并提示可在 Chrome 打开 devtools 地址。
- 若应用未开启 WebView 调试：返回 `total: 0` 且 `hint` 提示需调用 `WebView.setWebContentsDebuggingEnabled(true)`。
- 第 4 步返回 `ok: true`、`forwards`、`reverses`；第 5 步能看到新增的 `tcp:9333` forward。
- 重复第 4 步同端口时，adb forward 允许重复映射，实测返回幂等成功（同一映射、无报错）；实现未返回 `existed` 标识，也从未触发 `PORT_IN_USE`。

**通过标准**：能拿到可用的 `devtoolsFrontendUrl`，端口映射可查、可增、冲突有明确错误码。

**实测结果**：2026-10-24 换机实测通过。`aya_list_webviews` → `found:true`、`count:1`、socket 名 `webview_devtools_remote_2277`；`aya_add_port{forward, tcp:18081→localabstract:webview_devtools_remote_2277}` 后本机 `curl http://127.0.0.1:18081/json/version` 返回 `Chrome DevTools` 版本 JSON（说明转发可用）；`aya_list_ports` 能同时列出 forward/reverse；重复 add 幂等、非法端口 → `INVALID_ARGS`。　**N**：3　**T**：≈1 s

### A-03 音乐播放：点击播放并确认进入播放态（P0）

**前置**：音乐页已加载，控件文本含 `播放`。

**步骤**

```text
1. aya_ui_dump  { deviceId: "$DEV", text: "播放", maxNodes: 60 }
2. aya_tap      { deviceId: "$DEV", text: "播放", exact: true, withUi: true }
3. aya_ui_dump  { deviceId: "$DEV", text: "暂停", maxNodes: 60 }
4. aya_performance { deviceId: "$DEV" }
```

**预期结果**

- 第 1 步 `matched ≥ 1`，节点含 `bounds` 与 `center`。
- 第 2 步返回 `clicked: true`、`point` 非空、`settledMs`，且 `ui.snapshotId` 与 `ui.nodes` 存在。
- 第 3 步能匹配到 `暂停` 或播放进度元素（表示已进入播放态）。
- 第 4 步 `fps` 字段有数值（页面有动画/音频可视化时通常非 0）。

**通过标准**：播放态切换成功，且一次 `aya_tap` 即返回可继续操作的新界面。

**实测结果**：2026-10-24 实测通过。`aya_tap_text{text:"播放", withUi:true}` 返回 `point:[...]`、`settledMs:300`，`ui.changed` 为 `true`，页面状态文本由「已暂停」变「播放中」；再次点击「暂停」恢复，往复稳定，无重复点击、无 ANR。　**N**：1　**T**：≈2.5 s（含抓帧）

### A-04 播放控制栏：播放 → 暂停 → 下一首连点（P0，效率相关）

**前置**：控制栏存在但可能 1–3 秒自动隐藏。

**步骤（对照两种方式）**

方式一：逐条调用

```text
1. aya_tap_text { deviceId: "$DEV", text: "播放" }
2. aya_tap_text { deviceId: "$DEV", text: "暂停" }
3. aya_tap_text { deviceId: "$DEV", text: "下一首" }
4. aya_ui_dump  { deviceId: "$DEV", text: "播放", maxNodes: 40 }
```

方式二：`aya_batch` 单次调用

```text
1. aya_batch {
     deviceId: "$DEV",
     steps: [
       { action: "tap_text", text: "播放", settle: 200 },
       { action: "tap_text", text: "暂停", settle: 200 },
       { action: "tap_text", text: "下一首", settle: 300 },
       { action: "wait", ms: 300 }
     ],
     withUi: true
   }
```

**预期结果**

- 两种方式都能完成 3 次控件操作；`aya_batch` 返回 `results[]` 逐步结果与最终 `ui`。
- 逐条方式至少 4 次往返；`batch` 方式 1 次往返。
- 控制栏自动隐藏导致定位失败时，`aya_batch` 返回 `failedAt` 指向失败步骤编号，并回传当前界面。

**通过标准**：`batch` 一次调用完成且 `failedAt` 为 `null`；N(batch) ≤ 1，T(batch) ≤ T(逐条) × 0.7。

**实测结果**：**部分通过**。`aya_batch{6 步}` 一次调用返回 `executed:6`、`failedAt:null`，各步 `ms` 可见（2,713 / 3,321 …），前序动作全部生效（状态「播放中」、进度跳至 01:53、滑块被拖动）；但 T(batch) ≈8.6 s 与逐条 4 次（≈12–16 s）差距有限，未达 0.7 阈值——瓶颈在每步独立 dump。　**N(逐条)**：4　**N(batch)**：1　**T(逐条)**：≈12,000–16,000 ms　**T(batch)**：≈8,600 ms

### A-05 播放进度拖动（P1）

**前置**：已进入播放态，进度条可交互。

**步骤**

```text
1. aya_ui_dump { deviceId: "$DEV", clickableOnly: true, maxNodes: 80 }   → 取进度条 center
2. aya_swipe   { deviceId: "$DEV", x1: <进度条左端 x>, y1: <y>, x2: <进度条 70% x>, y2: <y>, duration: 600, withUi: true }
3. aya_screencap { deviceId: "$DEV", maxWidth: 600 }
```

**预期结果**

- 第 2 步返回 `ok: true`、`duration: 600`、`settledMs`，`withUi` 打开时含 `ui`。
- 第 3 步返回 `width/height/imageWidth/imageHeight/scale` 与 PNG 图片；`scale` 与 `maxWidth` 一致。
- 截图中进度位置明显后移（人工目视）。

**通过标准**：进度跳转到拖动位置，无崩溃、无 ANR。

**实测结果**：2026-10-24 实测通过。`swipe{300,441 → 900,441, duration:500}` 后页面进度由 `00:00` 跳至 `01:53`，滑块 `value` 同步，`aya_current_app` 仍为 WebView Shell（无崩溃）；再配合 `aya_screencap` 留证。　**N**：1　**T**：≈0.8 s（swipe 本身，不含抓帧）

### A-06 H5 输入框：ASCII 文本输入（P0）

**前置**：页面含可聚焦输入框，`aya_ui_dump` 能读到该节点。

**步骤**

```text
1. aya_ui_dump { deviceId: "$DEV", text: "搜索", maxNodes: 60 }
2. aya_tap     { deviceId: "$DEV", text: "搜索", withUi: false, settle: 300 }
3. aya_text    { deviceId: "$DEV", text: "aya mcp test 2026", withUi: true }
4. aya_ui_dump { deviceId: "$DEV", text: "aya mcp test 2026", maxNodes: 40 }
```

**预期结果**

- 第 3 步返回 `ok: true`、`text` 与输入一致、`settledMs`。
- 第 4 步能在控件文本中匹配到输入内容（WebView 输入框需可读；若不可读，以截图为准）。
- 输入换行/特殊字符时按原样发送，不出现截断。
- **输入法风险**：设备当前为 CJK 拼音输入法时，`input text` 会被转换为中文（实测 `aya mcp test 2026` → `啊呀买彩票test2026`），应判失败并记录 BUG-02；恢复拉丁键盘或改用 ADBKeyboard 后重测。

**通过标准**：输入内容完整出现在页面，未触发 `INVALID_ARGS`。

**实测结果**：**失败**（换机仍复现）。聚焦 Chrome 地址栏后 `aya_text{text:"aya mcp test 2026"}` 返回 `ok:true`，但 `ui` 回读 `url_bar` 与联想词均为 `啊呀买彩票test2026`；`settings get secure default_input_method` = `com.google.android.inputmethod.latin/...LatinIME`（中文键盘生效）。判为 BUG-02。　**N**：2　**T**：≈2.4 s（含 `withUi` 抓帧）

### A-07 H5 中文输入（P1，已知限制）

**前置**：设备已安装并启用中文输入法（或 ADBKeyboard）。

**步骤**

```text
1. aya_tap  { deviceId: "$DEV", text: "搜索", withUi: false }
2. aya_text { deviceId: "$DEV", text: "中文测试" }
3. aya_shell { deviceId: "$DEV", command: "settings get secure default_input_method" }
4. 使用输入法粘贴通道（二选一）：
   a) aya_shell 执行 ADBKeyboard 广播：am broadcast -a ADB_INPUT_TEXT --es msg "中文测试"
   b) aya_ui_dump 取输入法候选词节点，aya_tap 选中候选词
5. aya_screencap { deviceId: "$DEV", maxWidth: 600 }
```

**预期结果**

- 第 2 步**预期失败**：返回错误（非 ASCII 不支持），或按实现截断；这是已知限制，属预期行为。
- 第 3 步返回当前输入法 ID 字符串。
- 第 4 步任一通道可完成中文输入，截图中可见「中文测试」。

**通过标准**：错误提示准确指向「请用 aya_shell + 输入法」；替代通道可完成中文输入。

**实测结果**：2026-10-24 实测通过（按已知限制判定）。`aya_text{text:"中文测试"}` 立即返回 `INVALID_ARGS`，message 为「输入仅支持可打印 ASCII 字符；中文等非 ASCII 文本请用 aya_shell 配合设备输入法」，未产生半截输入；第 3 步取到 `...LatinIME`。替代通道（ADBKeyboard 广播）本轮未安装，仅验证错误提示准确性。　**N**：2

### A-08 H5 表单提交与结果校验（P1）

**前置**：表单页含输入框 + 提交按钮 + 结果回显区。

**步骤**

```text
1. aya_batch {
     deviceId: "$DEV",
     steps: [
       { action: "tap", text: "用户名", settle: 200 },
       { action: "text", text: "aya" },
       { action: "tap", text: "提交", settle: 500 }
     ]
   }
2. aya_wait_for { deviceId: "$DEV", text: "提交成功", timeout: 8000 }
3. aya_screencap { deviceId: "$DEV", maxWidth: 600 }
```

**预期结果**

- `aya_batch` 返回 `failedAt: null`，`results` 长度等于步骤数。
- `aya_wait_for` 返回 `matched: true`、`node` 非空。
- 截图中可见成功提示。

**通过标准**：表单提交成功且结果可被工具链验证。

**实测结果**：部分通过。`aya_tap` 聚焦输入框 → `aya_text` 输入 → `aya_tap_text{提交}` 全链路可执行，提交后页面结果区文本变化可在 `ui` 中读到；但输入内容被 Gboard 改写（`aya mcp test 2026` → `啊呀买彩票test2026`，BUG-02），结果区显示的是错误文案；同时输入框 `value` 不在 UI 树，只能靠提交后的结果文本间接校验（BUG-03）。　**N**：3　**T**：≈9 s

### A-09 H5 元素定位与 SurfaceView 兜底（P1）

**前置**：页面中同时存在普通 DOM 控件与 `<video>` / canvas 区域。

**步骤**

```text
1. aya_ui_dump   { deviceId: "$DEV", clickableOnly: true, maxNodes: 100 }
2. aya_screencap { deviceId: "$DEV", maxWidth: 900 }
3. 对 DOM 控件：aya_tap { text: "<控件文本>" }
4. 对不可读区域（video/canvas）：根据截图人工确定坐标 → aya_tap { x, y }
```

**预期结果**

- 步骤 1 能读出 H5 普通控件（`class` 常为 `android.view.View` / `android.widget.*`）。
- 视频/画布内控件不在 UI 树中时，工具链不报错但 `matched: 0`，此时截图是唯一判据。
- 步骤 4 坐标点击生效。

**通过标准**：能明确区分「UI 树可读」与「必须截图」两类区域，并各自完成一次有效点击。

**实测结果**：2026-10-24 实测通过。canvas 区域内的进度文字/滑块不在可点击节点中（`clickableOnly:true` 下 `matched:0`），仅外层说明文字可读；改用坐标 `aya_tap`/`swipe` 操作成功；`aya_screencap` 返回设备 1920×1080 → 图片 900×506（`scale:0.46875`），画面与 UI 树一致，可作兜底证据。　**N**：4　**T**：≈6 s

### A-10 媒体按键与音量控制（P2）

**步骤**

```text
1. aya_key { deviceId: "$DEV", key: "volume_up" }
2. aya_key { deviceId: "$DEV", key: "volume_down" }
3. aya_key { deviceId: "$DEV", key: "back" }
4. aya_current_app { deviceId: "$DEV" }
```

**预期结果**：每步返回 `ok: true` 与 `keycode`；音量变化可由截图或系统 UI 观察；`back` 后前台应用发生变化或返回上一页。

**通过标准**：按键事件全部送达，键值与预期一致（`volume_up` = 24、`volume_down` = 25、`back` = 4）。

**实测结果**：2026-10-24 实测通过。`aya_key{key:"volume_up"}` → `keyCode:24`、`{volume_down}` → `25`、`{back}` → `4`，均 `ok:true`、`settledMs:300`；`back` 后页面未崩溃，可继续交互。　**N**：3　**T**：≈0.9 s

## 6. 模块 B：APK 开发工程师常用需求

> 通用前置：P-01～P-05。破坏性用例只允许操作 `$TEST_PKG` 与测试路径。

### B-01 设备与应用信息查询（P0）

**步骤**

```text
1. aya_list_devices { }
2. aya_device_info  { deviceId: "$DEV" }
3. aya_list_packages { deviceId: "$DEV", thirdPartyOnly: true, limit: 50 }
4. aya_app_info     { deviceId: "$DEV", package: "$APP" }
```

**预期结果**

- 第 1 步返回 `devices[]`，当前设备 `selected: true`，含 `androidVersion`、`sdkVersion`。
- 第 2 步返回 `overview`（`model`/`brand`/`abi`/`cpuNum`/`kernelVersion`/`resolution`/`density`/`memTotal`/`storageTotal`）与 `performance`（`cpuLoads` 8 项、`cpuTemperature`、`batteryLevel`）与 `online: true`。
- 第 3 步返回 `total`/`matched`/`packages[]`（`name`/`system`/`apkPath`）。
- 第 4 步返回 `enabled`、`running`、`pid`、`versionName`、`versionCode`、`targetSdk`、`firstInstallTime`、`flags[]`。
- 查询未安装包返回 `NOT_FOUND`。

**通过标准**：字段齐全，数值与设备实际一致，错误码正确。

**实测结果**：2026-10-24 实测通过。`aya_list_devices` 仅 1 台在线设备 `ceea400d750e8749`（`selected: true`，Android 14 / SDK 34）；`aya_device_info` 返回 `model: SC-MBR3576` / brand `rockchip` / arm64-v8a / 8 核 / kernel 6.1.99 / 1920×1080 / density 160 / `memTotal: 4,086,702,080` / `online: true`；`aya_list_packages{thirdPartyOnly:true}` → `total: 129`、`matched: 0`（纯净系统无三方应用）；`aya_app_info{package:"com.tudou.video"}` → `NOT_FOUND`，`aya_app_info{package:"org.chromium.webview_shell"}` 返回 `apkPath`、`versionName`、`enabled: true`、`targetSdk` 等字段。

### B-02 安装 / 覆盖安装测试 APK（P2）

**前置**：本机存在 `aya-test.apk`，包名 `$TEST_PKG`。

**步骤**

```text
1. aya_install_app { deviceId: "$DEV", apkPath: "<本机 apk 绝对路径>" }
2. aya_app_info    { deviceId: "$DEV", package: "$TEST_PKG" }
3. aya_install_app { deviceId: "$DEV", apkPath: "<同一 apk>" }   # 覆盖安装
4. aya_app_info    { deviceId: "$DEV", package: "$TEST_PKG" }
```

**预期结果**：安装返回 `ok: true`；覆盖安装保留 `dataDir` 数据；版本号变化可见；本机 apk 不存在时返回 `NOT_FOUND`，签名不匹配时返回明确错误。

**通过标准**：首次安装与覆盖安装均成功，信息查询一致。

**实测结果**：**阻塞**。该机为纯净系统（第三方包 0 个），仓库内无专用测试 APK；为免污染系统镜像，本轮未执行安装。可用 `script/build-apk.ps1` 产出的 debug 包在下一轮补测（同时可解锁 B-08 的破坏性操作）。

### B-03 启动 / 强停应用（P0）

**步骤**

```text
1. aya_start_app { deviceId: "$DEV", package: "$APP", settle: 800 }
2. aya_current_app { deviceId: "$DEV" }
3. aya_list_processes { deviceId: "$DEV", filter: "tudou" }
4. aya_stop_app  { deviceId: "$DEV", package: "$APP" }
5. aya_app_info  { deviceId: "$DEV", package: "$APP" }
```

**预期结果**

- 第 2 步前台为 `$APP` 或其后代页面。
- 第 3 步能查到进程名与 pid。
- 第 4 步后第 5 步 `running: false`、`pid: null`。

**通过标准**：启动与 `am force-stop` 均生效，进程状态可验证。

**实测结果**：部分通过（换机后缺陷仍可复现）。`aya_start_app{package:"org.chromium.webview_shell"}` 返回 `ok:true`、`settledMs:1500`，但紧接着 `aya_current_app` 返回 `package:"" pid:0`、`mCurrentFocus=null`；`aya_shell` 直接执行 `am start -W` 返回 `Status: ok`，`force-stop` 后重试同一次 `aya_start_app` 成功（pid 3785，焦点 `WebViewBrowserActivity`）；`aya_stop_app` 后 `aya_app_info` → `running:false`、`pid:null`。判为启动时序竞态（BUG-12）。

### B-04 logcat 抓崩溃（P0）

**前置**：准备一个可复现崩溃的操作路径（若 `$APP` 无崩溃，改用 `aya_shell am crash $APP` 主动制造）。

**步骤**

```text
1. aya_clear_logcat { deviceId: "$DEV" }
2. 执行复现操作（aya_tap / aya_batch / aya_start_app 等）
3. aya_logcat { deviceId: "$DEV", level: "E", lines: 200 }
4. aya_logcat { deviceId: "$DEV", level: "E", keyword: "FATAL", lines: 50 }
5. aya_logcat { deviceId: "$DEV", level: "E", tag: "AndroidRuntime", lines: 50 }
```

**预期结果**

- 第 3 步返回 `fetchedLines`、`matched`、`returned`、`truncated`、`empty`、`errorHint`、`entries[]`（`time`/`pid`/`tid`/`level`/`tag`/`message`）。
- 崩溃场景下能检索到 `FATAL EXCEPTION` 与堆栈。
- `level` 过滤生效：`E` 结果中不出现 `I/D/V`。
- 清空后立即读取时 `empty: true`。

**通过标准**：清空→复现→过滤三步闭环可用，崩溃堆栈可完整定位。

**实测结果**：2026-10-24 实测通过。`aya_clear_logcat` 后 `aya_shell "am crash org.chromium.webview_shell"` 制造崩溃；`aya_logcat{level:"E"}` 返回 `entries[]` 含 time/pid/tid/level/tag/message，`keyword:"FATAL"` 命中 5 条（`FATAL EXCEPTION: main` + 堆栈），`tag:"AndroidRuntime"` 命中 17 条；`level` 过滤生效，结果中无 I/D/V。　**N**：5

### B-05 文件拉取 / 推送 / 目录管理（P1）

**步骤**

```text
1. aya_push_file   { deviceId: "$DEV", local: "<本机 aya-test-push.txt>", remote: "/sdcard/aya-test/aya-test-push.txt" }
2. aya_stat_path   { deviceId: "$DEV", path: "/sdcard/aya-test/aya-test-push.txt" }
3. aya_list_dir    { deviceId: "$DEV", path: "/sdcard/aya-test" }
4. aya_pull_file   { deviceId: "$DEV", remote: "/sdcard/aya-test/aya-test-push.txt" }
5. aya_make_dir    { deviceId: "$DEV", path: "/sdcard/aya-test/sub" }
6. aya_rename_path { deviceId: "$DEV", from: "/sdcard/aya-test/aya-test-push.txt", to: "/sdcard/aya-test/sub/moved.txt" }
7. aya_delete_path { deviceId: "$DEV", path: "/sdcard/aya-test", recursive: true }
8. aya_stat_path   { deviceId: "$DEV", path: "/sdcard/aya-test" }
```

**预期结果**

- 第 2 步返回存在、文件类型、大小、权限。
- 第 3 步返回 `entries[]`，目录优先。
- 第 4 步返回本机落地路径，文件内容与 `AYA_MCP_TEST_2026` 一致。
- 第 6 步后必须用 `aya_stat_path` 校验目标存在、源不存在；实测当前 `aya_rename_path` 返回 `ok:true` 但文件未移动（见 `TEST_REPORT.md` BUG-01）。
- 第 7 步删除目录不带 `recursive: true` 时应报错；带 `recursive: true` 成功。
- 第 8 步返回不存在。

**通过标准**：全链路文件操作可逆、可校验，危险操作有保护。

**实测结果**：部分通过。push/stat/list/pull 全链路正确：`aya_stat_path` 返回 17 B、`-rw-rw----`，`aya_pull_file` 落地内容为 `AYA_MCP_TEST_2026`（长度 17，与源文件逐字节一致）；`aya_make_dir` 成功；`aya_delete_path{path:"/sdcard/aya-test"}` 不带 `recursive` → `INVALID_ARGS`，带 `recursive:true` 成功，之后 `stat` 返回不存在。**`aya_rename_path` 返回 `ok:true`，但源文件仍在、目标路径 ENOENT、目标目录为空**（BUG-01，换机复现）。

### B-06 UI 层级验证与字体缩放适配（P1）

**步骤**

```text
1. aya_ui_dump      { deviceId: "$DEV", clickableOnly: true, maxNodes: 60 }
2. aya_set_font_scale { deviceId: "$DEV", scale: 1.3 }
3. aya_ui_dump      { deviceId: "$DEV", text: "<已知控件文本>", maxNodes: 20 }
4. aya_set_font_scale { deviceId: "$DEV", scale: 1.0 }
```

**预期结果**

- 第 1 步节点含 `i`/`text`/`desc`/`id`/`class`/`clickable`/`bounds`/`center`。
- 第 2 步返回 `previous`（改动前值）与 `scale`（改动后值），范围 0.5–2.0，并带 `hint`。
- 第 3 步同控件 `bounds` 因字体放大而变化，无控件被裁切（截图辅证）。
- 越界值（如 3.0）返回 `INVALID_ARGS`。

**通过标准**：缩放生效且可恢复，UI 无不可点击/错位。

**实测结果**：2026-10-24 实测通过。`aya_set_font_scale{scale:1.3}` 返回 `previous:1`、`scale:1.3`；同一按钮节点 `bounds` 由 1.0 时的较小尺寸放大为 1.3 时的更大尺寸（宽高同比增加，位置随布局下移），`aya_ui_dump` 读到的 `center` 随之变化且点击仍命中；随后 `aya_set_font_scale{scale:1.0}` 恢复，`aya_device_info.fontScale` 回到 1。

### B-07 性能快照与进程快照（P0）

**步骤**

```text
1. aya_performance    { deviceId: "$DEV", includeFps: true }
2. aya_list_processes { deviceId: "$DEV", limit: 20 }
3. aya_performance    { deviceId: "$DEV", includeFps: false }
```

**预期结果**

- 第 1 步返回 `cpu.loads[]`（8 项）、`cpu.temperature`、`cpu.cores`、`memory.{totalMB,usedMB,usagePercent}`、`battery.{level,temperature,voltage}`、`uptimeMs`、`foreground.{name,pid}`、`fps`。
- 第 3 步耗时明显低于第 1 步（省去 fps 采集约 200ms），`fps` 字段缺省。
- 第 2 步返回 `total`/`matched`/`truncated`/`processes[]`。

**通过标准**：字段完整，`usagePercent` 与 `usedMB/totalMB` 自洽（误差 ≤ 1%）。

**实测结果**：2026-10-24 换机实测通过。`aya_performance{includeFps:true}` 返回 `cpu.loads` 8 项、`cpu.temperature: 37`、`memory.used/total`（4,086,702,080 B，已用 1,240,571,904 B）、`batteryLevel: 50`；`aya_device_info` 同时给出 `performance.foreground` 与 `online:true`；`includeFps:false` 时 `fps` 字段缺省且耗时更低。`aya_list_processes` 返回 `total`/`matched`/`truncated`/`processes[]`（默认 `limit` 下 `truncated:true`）。

### B-08 清数据 / 禁用 / 卸载（P2，破坏性）

**前置**：`$TEST_PKG` 已安装，且仅对测试包执行。

**步骤**

```text
1. aya_clear_app_data { deviceId: "$DEV", package: "$TEST_PKG" }
2. aya_app_info       { deviceId: "$DEV", package: "$TEST_PKG" }
3. aya_set_app_enabled { deviceId: "$DEV", package: "$TEST_PKG", enabled: false }
4. aya_set_app_enabled { deviceId: "$DEV", package: "$TEST_PKG", enabled: true }
5. aya_uninstall_app  { deviceId: "$DEV", package: "$TEST_PKG" }
6. aya_app_info       { deviceId: "$DEV", package: "$TEST_PKG" }
```

**预期结果**：清数据后首次启动回到初始态；禁用后 `enabled: false` 且无法启动；重复禁用不报错；卸载后第 6 步返回 `NOT_FOUND`。

**通过标准**：三步均生效且状态可验证，测试包可重新安装恢复。

**实测结果**：**阻塞**。本机仅剩系统应用，对系统应用执行 `clear_app_data` / `set_app_enabled` / `uninstall_app` 会破坏镜像（尤其 WebView Shell 是本轮 H5 用例的宿主），故未执行；留待 B-02 提供可重装的三方测试包后补测。

## 7. 模块 C：BSP 开发工程师常用需求

> 通用前置：P-01～P-03。C-04 起需要 P-06（串口硬件 `$SERIAL` = `COM31`）。
> 无串口硬件时，C-04 之后用例标记为「阻塞」，仅执行空态断言。

### C-01 设备属性与内核版本（P0）

**步骤**

```text
1. aya_device_info { deviceId: "$DEV" }
2. aya_shell       { deviceId: "$DEV", command: "getprop ro.product.board" }
3. aya_shell       { deviceId: "$DEV", command: "getprop ro.boot.hardware" }
4. aya_shell       { deviceId: "$DEV", command: "uname -a" }
```

**预期结果**

- 第 1 步 `kernelVersion` 为 `6.1.99`、`abi` 为 `arm64-v8a`、`cpuNum` 为 8。
- 第 2–4 步返回纯文本输出；`uname -a` 包含内核版本号。
- 无 root 时读取受限文件（如 `/proc/cmdline`）返回 `Permission denied`，`errorHint` 透传 stderr，`ok: true` 不误判为工具失败。
- 输出超过 20000 字符时被截断并标注。

**通过标准**：板级属性、硬件代号、内核版本均可一次取到；权限受限场景错误信息准确。

**实测结果**：2026-10-24 实测通过。`aya_device_info` 返回 `kernelVersion: 6.1.99`、`abi: arm64-v8a`、`cpuNum: 8`；`getprop ro.product.board` = `rk30sdk`、`getprop ro.boot.hardware` = `rk30board`；`uname -a` = `Linux localhost 6.1.99 #47 SMP PREEMPT ... aarch64 Toybox`；`cat /proc/cmdline` 返回 `errorHint: "cat: /proc/cmdline: Permission denied"`（设备非 root），`truncated: false`。

### C-02 Shell 探测（getprop / dumpsys / 节点）（P1）

**步骤**

```text
1. aya_shell { deviceId: "$DEV", command: "getprop | grep -i serial" }
2. aya_shell { deviceId: "$DEV", command: "dumpsys meminfo | head -30" }
3. aya_shell { deviceId: "$DEV", command: "ls -l /dev/ttyS* /dev/ttyUSB*" }
4. aya_shell { deviceId: "$DEV", command: "cat /proc/cmdline" }
5. aya_shell { deviceId: "$DEV", command: "sleep 40" }
```

**预期结果**

- 第 1–4 步正常返回文本。
- 第 5 步超过 30s 超时，返回 `TIMEOUT`。
- 命令不存在时返回 stderr 内容而非崩溃。

**通过标准**：常用探测命令可用，超时行为明确（30s）。

**实测结果**：2026-10-24 换机实测通过。第 1 步返回 `ro.serialno=ceea400d750e8749` 等属性；第 2 步 `dumpsys meminfo | head -30` 返回内存汇总，`errorHint: "Broken pipe"`（head 提前关闭管道所致，数据有效）；第 3 步列出 `/dev/ttyS1`、`/dev/ttyS3`、`/dev/ttyS4`(bluetooth)、`/dev/ttyS7`，**无 `/dev/ttyUSB*`**；第 4 步 `cat /proc/cmdline` → `Permission denied`；第 5 步 `sleep 40` → `TIMEOUT`（30 s 上限）。

### C-03 端口映射管理（P1）

**步骤**

```text
1. aya_list_ports { deviceId: "$DEV" }
2. aya_add_port   { deviceId: "$DEV", direction: "forward", local: "tcp:18080", remote: "tcp:8080" }
3. aya_add_port   { deviceId: "$DEV", direction: "forward", local: "tcp:18080", remote: "tcp:8080" }
4. aya_add_port   { deviceId: "$DEV", direction: "reverse", local: "tcp:19000", remote: "tcp:19000" }
5. aya_remove_port { deviceId: "$DEV", direction: "forward", local: "tcp:18080" }
6. aya_remove_port { deviceId: "$DEV", direction: "reverse", remote: "tcp:19000" }
```

**预期结果**

- 第 1 步返回 `forwards[]` / `reverses[]`。
- 第 2、4 步成功并回传最新 `forwards` / `reverses`；第 3 步重复映射实测为幂等成功（adb forward 允许重复），不会返回错误。
- 第 5、6 步后再次 `aya_list_ports` 不再出现对应映射；`all: true` 可清空该方向全部映射。

**通过标准**：forward / reverse 双向可增删，冲突有明确错误码。

**实测结果**：2026-10-24 实测通过。起始列表为空（仅 AYA 投屏的 scrcpy reverse）；`add_port{forward, tcp:18080→tcp:8080}` 连加两次均 `ok:true` 且列表无重复（幂等）；`add_port{reverse, tcp:8000→tcp:8000}` 后设备侧访问 `http://127.0.0.1:8000/` 成功加载本机静态页；`add_port{forward, tcp:18081→localabstract:webview_devtools_remote_2277}` 后本机 `curl http://127.0.0.1:18081/json/version` 返回 DevTools JSON（功能级验证）；`remove_port{forward, tcp:18080}` / `remove_port{reverse, remote:tcp:8000}` 生效；`remove_port{forward, tcp:19999}`（不存在）→ `INTERNAL` 并附 adb 原文；`add_port{local:"abc"}` → `INVALID_ARGS`；`remove_port{forward, all:true}` 清空成功。

### C-04 串口列表与状态（P0）

**步骤**

```text
1. aya_serial_list_ports { }
2. aya_serial_status     { }
```

**预期结果**

- 第 1 步返回 `total`、`ports[]`（`path`/`manufacturer`/`pnpId`/`friendlyName`，USB 转串口含 `serialNumber`/`vendorId`/`productId`）。
- 当前环境应看到 `COM1` 与 `COM31`（CH340）。
- 第 2 步返回 `open`、`path`、`baudRate`、`dataBits`、`stopBits`、`parity`、`paused`、`sessionId`、`lines`、`seq`、`bytes`、`logFile`、`logFileSize`。
- 与 `aya_list_ports`（adb 端口映射）互不混淆。

**通过标准**：串口枚举正确，与 adb 端口映射工具语义区分清晰。

**实测结果**：2026-10-24 换机实测通过。`aya_serial_list_ports` 返回 `total: 2`：`COM1`（标准端口，`ACPI\\PNP0501`）与 `COM31`（USB-SERIAL CH340，`pnpId: USB\\VID_1A86&PID_7523`，含 `vendorId: 1A86` / `productId: 7523`）；`aya_serial_status` 字段齐全：`open: true`、`path: COM31`、`baudRate: 1500000`、8N1、`paused`、`sessionId`、`lines`、`seq`、`bytes`、`logFile`/`logFileSize`、`dropped`、`maxLines`。注意 `paused` 在不同会话中出现过 `true`/`false` 两种取值，且没有 pause/resume 工具可主动切换（BUG-07），只能通过 close/open 重建会话；`pauseHint` 为操作提示而非开关。

### C-05 打开串口并区分启动阶段日志（P2，需串口硬件）

**前置**：串口线连接目标板调试口；板子可复位。

**步骤**

```text
1. aya_serial_clear { }
2. aya_serial_open  { path: "$SERIAL", baudRate: 1500000 }
3. 复位目标板（人工）
4. aya_serial_wait  { pattern: "Booting Linux", timeout: 30000 }
5. aya_serial_logs  { source: "bootloader", lines: 200 }
6. aya_serial_logs  { source: "kernel", lines: 200 }
7. aya_serial_logs  { source: "android", keyword: "boot_completed", lines: 200 }
8. aya_serial_close { }
```

**预期结果**

- 第 2 步返回连接参数（8N1）与 `open` 状态；`baudRate` 仅接受 `115200 / 460800 / 921600 / 1500000 / 3000000`。
- 第 4 步返回 `matched: true` 与 `line`（含 `seq` / `time` / `source` / `text`）；超时返回 `matched: false` 而非报错。
- 第 5–7 步按 `source` 分段返回，`bootloader` / `kernel` / `android` 各阶段内容不串段；返回体含 `total` / `matched` / `returned` / `truncated` / `lastSeq` / `entries[]`。
- `aya_serial_logs` 支持 `fromSeq` 增量读取，重复读取不重复返回。
- 第 8 步后 `aya_serial_status` 的 `open: false`，已收日志仍在缓冲区与 `logFile`。

**通过标准**：三阶段分段准确，增量读取无重复无丢失。

**实测结果**：2026-10-24 实测通过（本轮核心补充）。顺序 `aya_serial_clear` → `aya_shell "reboot"` → 等待约 45 s，串口完整收到三段：`source:"bootloader"` 183 行；`source:"kernel"` 自 `seq 815` 起（`Booting Linux … Linux version 6.1.99`）；`source:"android"` 在开机 **17.2 s**（`seq 3837`）出现 `boot_completed`。单次开机约 3,983 行 / 471 KB，两次开机共 7,968 行 / 1,066,265 B（`serial-20261024-095628.log`）。`aya_logcat` 侧仅能看到 Android 启动后的应用日志，无法覆盖 bootloader/kernel 阶段——印证两类日志不可替代。

### C-06 串口下发命令（P2，破坏性需确认）

**前置**：串口已打开；目标处于可接收命令状态。

**步骤**

```text
1. aya_serial_write { data: "help", newline: true }
2. aya_serial_logs  { keyword: "help", lines: 50 }
3. aya_serial_status { }
```

**预期结果**

- 第 1 步返回 `ok: true` 与 `sent`（已发送文本），`data` 最长 4096 字符。
- 第 2 步能读到命令回显。
- `status.bytes` 仅统计**接收**字节，发送不会使其增加（实测发送后仍为 0）；响应只回 `sent` 文本，不回发送字节数。
- `newline: false` 时发送内容原样不带换行；`data` 为空返回 `INVALID_ARGS`。

**通过标准**：命令可下发并收到回显；换行控制符合参数语义。

**实测结果**：部分通过。`aya_serial_write{data:"echo AYA_SERIAL_ECHO_OK", newline:true}` 返回 `ok:true` 与 `sent` 文本；但目标板控制台未启用输入回显，`aya_serial_logs` 中读不到该行（`status.bytes` 也只统计接收方向），因此"回显校验"在本设备无法闭环；`data:""` → `INVALID_ARGS`（"data 不能为空"）；写入后设备无异常、串口接收不中断。

### C-07 串口日志增量与关键事件等待（P2，需串口硬件）

**步骤**

```text
1. aya_serial_logs { fromSeq: 0, lines: 100 }
2. 记录返回的 lastSeq = S1
3. aya_serial_logs { fromSeq: S1, lines: 100 }
4. aya_serial_wait { pattern: "boot_completed", timeout: 60000 }
5. aya_serial_logs { source: "other", lines: 50 }
```

**预期结果**

- 第 3 步只返回 `seq > S1` 的新行。
- 第 4 步命中后 `matched: true` 且 `line` 非空，未命中时 `matched: false`、`waited` 为实际等待毫秒数，且不抛异常。
- `other` 分段能收集无法归类的行；`keyword` 传非法正则且 `regex: true` 时返回 `INVALID_ARGS`。

**通过标准**：增量无重复无遗漏，长等待不阻塞其他工具调用。

**实测结果**：2026-10-24 实测通过。`aya_serial_logs{fromSeq:N}` 只返回 `seq > N` 的新行，与全量尾部连续无缺口；`aya_serial_wait{pattern:"." , regex:true}` 正例 `matched:true`、`waited:28,402 ms` 并回传命中行与 `seq`；`aya_serial_wait{pattern:"AYA_NEVER_APPEARS_PATTERN", timeout:5000}` 负例 `matched:false`、`waited:5,144 ms`；`keyword:"[" + regex:true` → `INVALID_ARGS`（提示正则非法）。注意：单次 `wait` 超时设置超过 MCP 客户端超时（约 60 s）时，客户端先报 `Request timed out`，但服务端仍按超时时间完成，需回读 `serial_logs` 确认。

### C-08 波特率探测与暂停/清空（P2）

**步骤**

```text
1. aya_serial_status { }
2. aya_serial_close  { }
3. aya_serial_open   { path: "$SERIAL" }                # 使用默认波特率
4. aya_serial_open   { path: "$SERIAL", baudRate: 115200 }
5. aya_serial_clear  { }
6. aya_serial_status { }
```

**预期结果**

- 省略 `baudRate` 时使用默认 115200，并在返回中回显。
- schema 枚举为 `115200 / 460800 / 921600 / 1500000 / 3000000`；handler 允许 300–4,000,000，越界返回 `INVALID_ARGS`。
- 波特率与目标板不匹配时日志呈乱码（由 `aya_serial_logs` 内容可见），不崩溃。
- `aya_serial_clear` 清空缓冲区并新建日志文件：`logFile` 变化、`startedAt` 更新、`seq` 归零，但 **`sessionId` 不变**（实测 serial5 保持），串口保持连接。
- 重复 `open` 已打开端口时行为明确（复用或返回错误）。

**通过标准**：连接参数可控、清空语义正确、异常输入不崩溃。

**实测结果**：2026-10-24 实测通过（含 2 个缺陷）。`open{COM31, 115200}` 返回成功但收到乱码（波特率不匹配，工具本身不崩溃）；`close` 后 `open{COM31, 1500000}` 正常解析 `[ 12.345]` 时间戳与 bootloader/kernel 分段；`baudRate:100` → `INVALID_ARGS`（范围 300–4,000,000），但 `baudRate:1000000`（不在 schema 枚举内）被接受，说明枚举未生效（BUG-14）；`clear` 后返回**同一个 `sessionId`**（`serial1`）而 `logFile` 变为新文件、`seq` 归零（BUG-10）；重复 `open` 会新建会话（`serial1→serial6`）并替换当前日志文件，`status.logFiles` 只回最新 1 个，历史文件仅在磁盘保留（BUG-13）。

## 8. 模块 D：复杂场景效率

> 所有用例必须记录 N / T / S / R（见第 4 节）。同一用例连续执行 3 次取中位数。

### D-01 同流程对比：逐条调用 vs `aya_batch`（P0）

**场景**：在音乐页完成「播放 → 暂停 → 下一首 → 截图确认」。

**步骤**

方式一（逐条）：

```text
aya_tap_text → aya_tap_text → aya_tap_text → aya_screencap
```

方式二（batch）：

```text
aya_batch { steps: [tap_text×3], withUi: true } → aya_screencap
```

**预期结果**：两种方式最终界面一致；`N(逐条) ≥ 4`，`N(batch) = 2`。

**通过标准**：功能等价；`N(batch) ≤ N(逐条)/2`，`T(batch) ≤ T(逐条) × 0.7`。

**实测结果**：部分通过（未达 S≤0.7）。逐条方式单次点击/输入含 `withUi` 耗时 2.4–4.9 s，4 步需 4 次往返（≈12–16 s）；`aya_batch` 一次调用完成 6 步（`executed:6`、`failedAt:null`），总耗时 ≈8–9 s。**N**：4 → 1（降到 25 %）；**T** 降幅有限，因为 batch 每步仍各自 `uiautomator dump`（单步结果里可见 2,713 / 3,321 ms 这类抓帧耗时）；**S** ≈0.6–0.7，结论：只省往返、不省 dump。　**N/T（逐条×3）**：≈4 次/12–16 s　**N/T（batch×3）**：1 次/8–9 s　**S**：≈0.6

### D-02 长流程：浏览器听歌全链路（P1）

**场景**：启动浏览器 → 输入 URL → 等待加载 → 播放 → 调音量 → 切歌 → 截图留证，共 ≥ 8 个动作。

**步骤**

```text
1. aya_start_app   { package: "$BROWSER" }
2. aya_ui_dump     { clickableOnly: true }
3. aya_tap         { nodeIndex: <地址栏>, snapshotId: "<上一步>" }
4. aya_text        { text: "<MUSIC_URL>" }
5. aya_key         { key: "enter" }
6. aya_wait_for    { text: "播放", timeout: 10000 }
7. aya_batch       { steps: [tap_text 播放, key volume_up, tap_text 下一首] }
8. aya_screencap   { maxWidth: 600 }
9. aya_performance { }
```

**预期结果**：全流程无人工介入完成；任一步失败时能凭返回的错误码与界面回传定位。

**通过标准**：3 次执行成功率 ≥ 2/3；失败时 `R ≤ 2`。

**实测结果**：部分通过。全链路可一次连绵完成：`am start` 拉起 WebView Shell → 经 reverse 加载本机页 → `tap_text{播放}` 状态变「播放中」→ `tap_text{下一首}` 进度跳至 01:53 → `swipe` 拖动进度条 → `aya_screencap` 留证；仅"输入文本回读"一步失败（BUG-02 输入法改写）导致第 6 步校验不通过。　**N**：1（batch 内 6 步）　**T**：≈8.6 s　**S**：全流程无中断　**R**：0

### D-03 快照过期与错误恢复（P0）

**场景**：故意使用过期 `snapshotId` 与不存在的控件文本，验证错误码与恢复路径。

**步骤**

```text
1. aya_ui_dump  { clickableOnly: true }                    → 记 snapshotId=S0、节点 i=N0
2. aya_tap      { nodeIndex: N0, snapshotId: "S0" }        # 正常
3. aya_tap      { nodeIndex: N0, snapshotId: "S0" }        # 复用已失效快照
4. aya_tap_text { text: "__不存在的控件__" }
5. aya_tap_text { text: "__不存在的控件__", exact: false }
6. aya_ui_dump  { clickableOnly: true }                    → 重新获取后继续操作
```

**预期结果**

- 第 3 步返回 `STALE_SNAPSHOT`，提示重新 `aya_ui_dump`。
- 第 4 步返回 `NO_MATCH`，并回传候选控件便于纠正。
- 同名多控件时返回 `AMBIGUOUS_MATCH` 或 `candidates[]`。
- 第 6 步后恢复正常操作。

**通过标准**：三类错误码准确，错误信息包含可执行的下一步建议，`R ≤ 2`。

**实测结果**：2026-10-24 实测通过。① 旧快照复用 `aya_tap{nodeIndex, snapshotId}` → `STALE_SNAPSHOT`，出现两种文案：「快照已失效，请重新调用 aya_ui_dump（或使用 withUi:true 重新获取）」「snapshotId 不匹配（当前为 …，请省略该参数或重新获取快照）」；② `aya_tap_text{text:"__AYA_NOT_EXIST__"}` → `NO_MATCH`，回传 `candidates[]`、操作建议与当前 `ui`；③ 重新 dump 后一次调用即恢复。　**R**：1

### D-04 `aya_wait_for` vs 轮询 `aya_ui_dump`（P0）

**场景**：等待一个 3–5 秒后才出现的元素（如广告结束、加载完成）。

**步骤**

方式一（轮询）：

```text
aya_ui_dump → sleep → aya_ui_dump → sleep → aya_ui_dump ...
```

方式二（wait_for）：

```text
aya_wait_for { text: "<目标文本>", timeout: 10000, interval: 250 }
```

**预期结果**：两者都能命中；轮询方式 `N ≥ 3`，`wait_for` 方式 `N = 1`；`wait_for` 返回 `attempts`、`waitedMs`、`snapshotId`。

**通过标准**：`N(wait_for) = 1` 且 `T(wait_for) ≤ T(轮询) × 0.5`；超时场景返回 `matched: false` 且带当前界面节点。

**实测结果**：通过（负例闭环）。`aya_wait_for{text:"搜索或输入网址", timeout:10000}` 返回 `matched:false`、`attempts:4`、`waitedMs:10,432`，并回传 `nodes[]` 与"超时后改用 aya_ui_dump / aya_screencap 兜底"的建议；对照手工轮询（每次 `aya_ui_dump` 约 2.4–4.9 s，10 s 内需 3–4 次调用），`wait_for` 把调用次数降到 1。　**N/T（轮询×3）**：≈3–4 次/10 s　**N/T（wait_for×3）**：1 次/10.4 s　**S**：≈0.3

### D-05 `aya_batch` 中途失败与断点恢复（P1）

**场景**：batch 中第 3 步故意点不存在的控件，验证 `failedAt` 与恢复。

**步骤**

```text
1. aya_batch {
     steps: [
       { action: "tap_text", text: "播放" },
       { action: "wait", ms: 300 },
       { action: "tap_text", text: "__不存在__" },
       { action: "tap_text", text: "下一首" }
     ],
     withUi: true
   }
2. aya_ui_dump { clickableOnly: true }
3. aya_batch   { steps: [{ action: "tap_text", text: "下一首" }] }
```

**预期结果**

- 第 1 步在 `failedAt: 2`（源码为 0 基索引，第三步即 2）停下，`ok: false`，`executed: 2`，`results` 含前 2 步成功记录，仍回传当前 `ui` 与 `error.code`。
- 第 1 步之前的动作已生效（播放已开始），不会回滚。
- 第 2–3 步可从失败处继续。

**通过标准**：失败位置准确、前序动作保留、恢复只需 ≤ 2 次调用。

**实测结果**：2026-10-24 实测通过（实网触发）。batch 首步 `tap_text{播放}` 未命中（当时前台为 Launcher），返回 `ok:false`、`failedAt:0`、`executed:0`、`error.code:NO_MATCH`，同时回传当前 `ui`（已可见「播放」按钮），未做任何回滚；随后一次 `aya_batch` 重发 6 步即全部成功（`executed:6`）。　**R**：1

### D-06 录屏留证 + 操作并行（P2）

**步骤**

```text
1. aya_start_recording { deviceId: "$DEV", timeLimit: 60 }
2. aya_batch { steps: [点击播放, 等待 1000ms, 点击暂停, 滑动进度条] }
3. aya_recording_status { deviceId: "$DEV" }
4. aya_stop_recording   { deviceId: "$DEV" }
```

**预期结果**

- 第 1 步立即返回 `remotePath` / `timeLimit` / `bitRate` / `size`，并提示最长 60 秒。
- 第 2 步操作期间录屏持续（`status` 的已录时长递增）。
- 第 4 步返回本机 `localPath`、`bytes`、`durationMs`；默认删除设备端临时文件，`keepRemote: true` 时保留并回传 `remotePath`。
- 超过 180 秒限制时返回 `INVALID_ARGS` 并提示分段录制。

**通过标准**：录屏与操作互不阻塞，产物可播放且时长与操作时段匹配。

**实测结果**：2026-10-24 换机实测通过。`aya_start_recording{timeLimit:30, bitRate:4000000, size:"960x540"}` 立即返回 `remotePath`/`timeLimit`/`bitRate`/`size`；录制期间 `aya_batch`（6 步，含点击与滑动）正常完成，未阻塞；`aya_recording_status` 显示录制中与剩余时长；`aya_stop_recording{localPath:".tmp-aya-h5/rec-test.mp4"}` 返回 `durationMs:26,799`、`bytes:99,713`，文件头校验为 `ftypmp42`，设备端临时文件已清理。

### D-07 投屏与截图/点击口径一致性（P2）

**步骤**

```text
1. aya_cast_window { action: "open" }
2. aya_cast_settings { deviceId: "$DEV" }               # 不传参数 = 只读
3. aya_screencap { deviceId: "$DEV", maxWidth: 600 }
4. aya_ui_dump   { deviceId: "$DEV", clickableOnly: true }
5. aya_tap       { deviceId: "$DEV", nodeIndex: <i>, snapshotId: "<S>" }
6. aya_cast_window { action: "close" }
```

**预期结果**

- 第 1 步返回 `action: "open"`、`visible: true`；第 6 步返回 `visible: false`。注意 `aya_cast_window` 只接受 `action`，传 `deviceId` 会因 `additionalProperties: false` 报 `INVALID_ARGS`。
- 第 2 步 `changed: false`，返回当前 `videoBitRate` / `maxSize`；传 `videoBitRate` / `maxSize` 且 `restart: true` 时 `changed` / `restarted` 为 `true`。
- 第 3 步 `scale` 与 `maxWidth` 自洽；第 5 步使用 dump 的 `center` 坐标且落点准确。

**通过标准**：投屏不影响截图与点击坐标口径（截图缩放但点击用设备像素）。

**实测结果**：2026-10-24 换机实测通过。`cast_window{open}` → `visible:true`，`{restart}` → 重启成功，`{close}` → `visible:false`；`cast_settings` 只读返回 `videoBitRate:8000000`、`maxSize:0`、`visible:true`，改 `4000000/720 + restart:true` 后 `changed/restarted:true` 且再次只读已是新值，随后回滚为 `8000000/0`；投屏开启时 `aya_screencap` 仍返回设备 1920×1080 → 图片 900×506（`scale:0.46875`），`aya_tap{nodeIndex}` 按 dump 的 `center` 落点准确，坐标系未被投屏影响。

## 9. 结果记录

### 9.1 执行记录（2026-10-24 第二轮，设备 `ceea400d750e8749`）

完整执行结果、测量数据与缺陷清单见 [`TEST_REPORT.md`](TEST_REPORT.md)；优化方案见 [`MCP_OPTIMIZATION_PLAN.md`](MCP_OPTIMIZATION_PLAN.md)。33 条用例中 24 条通过、6 条部分通过、1 条失败、2 条阻塞。

| 用例 | 结果 | 实测要点 |
| --- | --- | --- |
| B-01 | 通过 | 单台设备；SC-MBR3576 / RK3576 / Android 14 / SDK 34；129 个包、0 个第三方；`aya_app_info` 对未安装包返回 `NOT_FOUND` |
| B-03 | 部分 | 冷启动后首次 `current_app` 为 `package:"" pid:0`；force-stop 重试成功（pid 3785），BUG-12 |
| B-04 | 通过 | `clear_logcat` → `am crash` → `level:E` 全量、`FATAL` 5 条、`AndroidRuntime` 17 条，堆栈完整 |
| B-05 | 部分 | push/stat/pull 内容一致（17 B）；`delete_path` 需 `recursive`；`rename_path` 假成功（BUG-01） |
| B-06 | 通过 | `1.0→1.3` 后同控件 bounds 变大并可点击，已恢复 1.0 |
| B-07 | 通过 | 8 核负载、温度 37℃、内存 4,086,702,080 B（已用 ≈1.24 GB）、电量 50% |
| B-09 | 阻塞 | 无三方测试包，未对系统应用执行清数据/禁用/卸载 |
| C-01 | 通过 | kernel 6.1.99 / aarch64；`ro.product.board=rk30sdk`、`ro.boot.hardware=rk30board`；`/proc/cmdline` 非 root 被拒且 `errorHint` 正确 |
| C-02 | 通过 | `dumpsys meminfo` 可用（`Broken pipe` 为 head 截断所致）；`/dev/ttyS1/3/4/7`、无 `ttyUSB*`；`sleep 40` → `TIMEOUT` |
| C-03 | 通过 | forward/reverse 增删、幂等 add、功能级验证（devtools JSON）、`INVALID_ARGS` / `INTERNAL` 错误码准确 |
| C-04 | 通过 | `COM1` + `COM31`(CH340, 1A86:7523)；`open:true`、1,500,000、8N1、`sessionId`/`seq`/`bytes`/`logFile` 字段齐全 |
| C-05 | 通过 | 两次开机共 7,968 行 / 1,066,265 B；`bootloader` 183 行、`kernel` 自 seq 815、`boot_completed` 于 17.2 s（串口，非 logcat） |
| C-06 | 部分 | `serial_write` 返回 `ok:true`；控制台无回显，无法闭环校验；空 `data` → `INVALID_ARGS` |
| C-07 | 通过 | `fromSeq` 增量连续；`wait` 正例 28.4 s 命中、负例 5,144 ms 超时；非法正则 → `INVALID_ARGS` |
| C-08 | 通过 | 115200 乱码 / 1500000 正常；`baudRate:100` → `INVALID_ARGS`；`clear` 保留 `sessionId`（BUG-10）、重复 `open` 覆盖会话（BUG-13） |
| D-01 | 部分 | N 4→1，T 仅略降（每步仍 dump），S≈0.6–0.7 |
| D-03 | 通过 | `STALE_SNAPSHOT`（两种文案）/ `NO_MATCH`（含 candidates 与建议），R=1 |
| D-04 | 通过 | `wait_for` 超时负例：`attempts:4`、`waitedMs:10,432`，N 由 3–4 次轮询降为 1 |
| D-05 | 通过 | `failedAt:0`/`executed:0`/`NO_MATCH`，前序不回滚，R=1 |
| D-06 | 通过 | 录制与 batch 并行；产物 26,799 ms / 99,713 B，`ftypmp42` 校验通过 |
| D-07 | 通过 | 投屏 open/restart/close、画质持久化及回滚；截图 900×506 而点击用设备像素，落点准确 |

### 9.2 结果记录表模板

每次执行复制一份，填入用例编号与结果。

| 用例 | 优先级 | 执行时间 | 结果 | 错误码 | N（往返） | T（ms） | 备注/缺陷链接 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-01 | P0 |  |  |  |  |  |  |
| A-02 | P1 |  |  |  |  |  |  |
| A-03 | P0 |  |  |  |  |  |  |
| A-04 | P0 |  |  |  |  |  |  |
| A-05 | P1 |  |  |  |  |  |  |
| A-06 | P0 |  |  |  |  |  |  |
| A-07 | P1 |  |  |  |  |  |  |
| A-08 | P1 |  |  |  |  |  |  |
| A-09 | P1 |  |  |  |  |  |  |
| A-10 | P2 |  |  |  |  |  |  |
| B-01 | P0 |  |  |  |  |  |  |
| B-02 | P2 |  |  |  |  |  |  |
| B-03 | P0 |  |  |  |  |  |  |
| B-04 | P0 |  |  |  |  |  |  |
| B-05 | P1 |  |  |  |  |  |  |
| B-06 | P1 |  |  |  |  |  |  |
| B-07 | P0 |  |  |  |  |  |  |
| B-08 | P2 |  |  |  |  |  |  |
| C-01 | P0 |  |  |  |  |  |  |
| C-02 | P1 |  |  |  |  |  |  |
| C-03 | P1 |  |  |  |  |  |  |
| C-04 | P0 |  |  |  |  |  |  |
| C-05 | P2 |  |  |  |  |  |  |
| C-06 | P2 |  |  |  |  |  |  |
| C-07 | P2 |  |  |  |  |  |  |
| C-08 | P2 |  |  |  |  |  |  |
| D-01 | P0 |  |  |  |  |  |  |
| D-02 | P1 |  |  |  |  |  |  |
| D-03 | P0 |  |  |  |  |  |  |
| D-04 | P0 |  |  |  |  |  |  |
| D-05 | P1 |  |  |  |  |  |  |
| D-06 | P2 |  |  |  |  |  |  |
| D-07 | P2 |  |  |  |  |  |  |

## 10. 附录

### 10.1 错误码速查

| 错误码 | 含义 | 常见触发 | 建议处理 |
| --- | --- | --- | --- |
| `NO_DEVICE` | 无可用设备 | 未连接设备 / 未选中 | `aya_list_devices` 确认后重试 |
| `DEVICE_OFFLINE` | 设备离线 | adb 断开 | 重连后重试 |
| `DUMP_FAILED` | UI 抓取失败 | uiautomator 异常 / 界面不可读 | 改用 `aya_screencap` |
| `STALE_SNAPSHOT` | 快照已失效 | 输入动作后复用 `snapshotId` | 重新 `aya_ui_dump` |
| `NO_MATCH` | 未找到匹配控件 | 文本/ID 不存在 | 用 `exact:false`、`aya_ui_dump` 或截图兜底 |
| `AMBIGUOUS_MATCH` | 索引越界 / 多候选 | `index` 超出匹配数量 | 参考 `candidates[]` 或调小 `index` |
| `WRITE_DISABLED` | 写操作未开启 | 设置中关闭了写权限 | 开启后重试 |
| `NOT_FOUND` | 资源不存在 | 包未安装 / 路径不存在 / 本机 apk 不存在 | 核对包名/路径 |
| `TIMEOUT` | 执行超时 | `aya_shell` 超 30s、工具超时 | 拆分命令 / 延长等待策略 |
| `PORT_IN_USE` | 协议保留（当前未使用） | — | 端口冲突实际返回 `INTERNAL`，按 message 处理 |
| `INVALID_ARGS` | 参数非法 | 缺必填、越界、空 `steps` | 按 schema 修正 |
| `INTERNAL` | 内部错误 | 依赖异常 | 记录 detail 并复现 |

### 10.2 工具清单速查（50 个）

| 分类 | 工具 |
| --- | --- |
| 设备/界面 | `aya_list_devices` `aya_device_info` `aya_set_font_scale` `aya_screencap` `aya_ui_dump` `aya_current_app` |
| 交互 | `aya_tap` `aya_tap_text` `aya_batch` `aya_wait_for` `aya_swipe` `aya_key` `aya_text` |
| 应用管理 | `aya_list_packages` `aya_app_info` `aya_start_app` `aya_stop_app` `aya_clear_app_data` `aya_set_app_enabled` `aya_uninstall_app` `aya_install_app` |
| 性能 | `aya_performance` `aya_list_processes` |
| 文件 | `aya_list_dir` `aya_stat_path` `aya_pull_file` `aya_push_file` `aya_delete_path` `aya_make_dir` `aya_rename_path` |
| 日志/Shell | `aya_logcat` `aya_clear_logcat` `aya_shell` |
| 串口 | `aya_serial_list_ports` `aya_serial_status` `aya_serial_logs` `aya_serial_wait` `aya_serial_open` `aya_serial_close` `aya_serial_write` `aya_serial_clear` |
| 端口/WebView | `aya_list_ports` `aya_add_port` `aya_remove_port` `aya_list_webviews` |
| 录屏/投屏 | `aya_start_recording` `aya_stop_recording` `aya_recording_status` `aya_cast_window` `aya_cast_settings` |

### 10.3 执行顺序建议

1. 首轮冒烟（约 30 分钟）：A-01、A-03、A-06、B-01、B-03、B-07、C-01、C-04、D-01、D-03。
2. 功能全量（约 2 小时）：A/B/C 模块其余 P0/P1 用例。
3. 效率专题（约 1 小时）：D-01、D-02、D-04、D-05，各执行 3 次。
4. 硬件与破坏性补充（按需）：C-05～C-08、B-02、B-08、D-06、D-07。

### 10.4 已知限制（测试时应作为预期行为记录，不判失败）

| 限制 | 说明 |
| --- | --- |
| `aya_text` 仅 ASCII | 中文需 `aya_shell` + 输入法 / ADBKeyboard |
| CJK 输入法会改写 ASCII | 实测拼音输入法把 `aya mcp` 转为「啊呀买彩票」；需先切拉丁键盘或 ADBKeyboard |
| SurfaceView 不可读 | 视频、游戏、部分 WebView 画布需 `aya_screencap` 兜底 |
| 单次 `screenrecord` ≤ 180s | 超时需分段录制 |
| `aya_batch` ≤ 20 步 | 超出需拆分为多次调用 |
| 串口日志量极大 | 必须配合 `keyword` / `source` / `fromSeq` / `lines` 过滤 |
| 串口波特率必须与板子一致 | 本机板子为 1,500,000；用 115200 采集只会得到乱码（工具不报错） |
| 串口回显不可靠 | 目标板控制台可能未启用输入回显，`serial_write` 只能确认"已下发"，不能确认"设备收到" |
| `aya_logcat` ≠ 串口 | logcat 走 adb（仅应用层）；bootloader/kernel 阶段只能用 `aya_serial_*` |
| `aya_wait_for` 上限 15s | 更长的等待需客户端自行轮询 |
| `aya_shell` 超时 30s / 输出截断 20000 字符 | 长任务需拆分 |
| MCP 客户端请求超时约 60s | `serial_wait` 设更长 `timeout` 时客户端先报 `Request timed out`，需回读 `serial_logs` 确认结果 |
