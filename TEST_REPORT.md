# AYA MCP 引用测试报告

> 执行日期：2026-10-24（第二轮，换机复测）　被测版本：aya-mcp v2.2.1
> 设备：`ceea400d750e8749`（SC-MBR3576 / RK3576 / Android 14 / SDK 34 / 8 核 / kernel 6.1.99 / 1920×1080 / density 160 / 4 GB）
> 计划：`TEST_PLAN.md`　优化方案：`MCP_OPTIMIZATION_PLAN.md`

## 0. 日志来源口径（重要）

| 工具 | 日志来源 | 适用范围 |
| --- | --- | --- |
| `aya_logcat` / `aya_clear_logcat` | **adb logcat**（`logcat -d`，按 level/tag/keyword 在主机侧过滤） | 应用崩溃、ANR、Java/native 层日志 |
| `aya_serial_*` | **主机 USB 串口**（`COM31`，CH340，1,500,000 8N1）接目标板调试口，采集的是真实串口输出 | bootloader / kernel 启动阶段、开机过程、内核 panic、串口控制台 |
| `aya_shell` | adb shell | 属性、dumpsys、文件系统探测 |

> 二者互不替代：logcat 拿不到 bootloader/kernel 阶段内容，串口拿不到 logcat 的应用日志。本报告中所有"启动阶段日志"结论均来自串口采集。

## 1. 执行概况

执行方式：通过 aya MCP 工具真实驱动设备。H5 用例使用本机静态页（`.tmp-aya-h5`）+ `aya_add_port{direction:"reverse"}` 映射到设备 `127.0.0.1:8000`，宿主为 WebView Shell（`org.chromium.webview_shell`）。

| 结果 | 数量 | 用例 |
| --- | --- | --- |
| 通过 | 24 | A-01～A-05、A-07、A-09、A-10、B-01、B-04、B-06、B-07、C-01～C-05、C-07、C-08、D-03、D-04、D-05、D-06、D-07 |
| 部分通过 | 6 | A-08、B-03、B-05、C-06、D-01、D-02 |
| 失败 | 1 | A-06 |
| 阻塞 | 2 | B-02（无测试 APK）、B-08（无专用测试包，未对系统应用执行破坏性操作） |
| 合计 | 33 |  |

## 2. 关键测量数据

| 指标 | 实测值 | 采集场景 |
| --- | --- | --- |
| 单次 UI dump（fast） | 2,391 / 2,505 / 4,828 / 4,931 ms | `aya_ui_dump`、`aya_tap{withUi:true}`、`aya_text{withUi:true}` |
| 点击落点稳定耗时 `settledMs` | 120 ms（按 `nodeIndex`）/ 300 ms（按坐标或用例指定） | `aya_tap`、`aya_key` |
| 6 步 `aya_batch` | N=1，`executed:6`，`failedAt:null` | 播放→等待→下一首→等待→滑进度→等待 |
| `aya_batch` 失败定位 | `failedAt:0`、`executed:0`、`error.code=NO_MATCH`，同时回传当前 `ui` | 首步 `tap_text` 未命中 |
| `aya_wait_for` 超时 | `attempts:4`、`waitedMs:10,432`、`matched:false`、附 `nodes[]` 与 `hint` | 等一个不存在的文本 |
| 截图 | 设备 1920×1080 → 图片 900×506，`scale:0.46875` | `aya_screencap` |
| 录屏 | 26,799 ms / 99,713 B（`ftypmp42` 头校验通过） | `aya_start_recording`+`aya_stop_recording` |
| logcat 抓崩溃 | `FATAL` 命中 5 条、`AndroidRuntime` 命中 17 条 | `aya_clear_logcat` → `am crash` → `aya_logcat` |
| 串口吞吐 | 两次开机共 **7,968 行 / 1,066,265 B**（`serial-20261024-095628.log`） | `aya_serial_*` @1,500,000 |
| 启动阶段分段 | `bootloader` 183 行；`kernel` 自 `seq 815` 起；`android` 首条 `boot_completed` 于开机 **17.2 s**（`seq 3837`） | `aya_serial_logs{source}` |
| 串口写 | `ok:true`、`sent` 文本正确；**无回显**（控制台输入未启用），`status.bytes` 仅统计接收 | `aya_serial_write` |
| 端口转发功能验证 | forward `tcp:18081 → localabstract:webview_devtools_remote_2277`，本机 `curl /json/version` 返回 Chrome DevTools JSON | `aya_add_port` |

> 结论不变：**耗时几乎全部来自 uiautomator dump（2.4–4.9 s）**，点击/按键本身只占 120–300 ms；`aya_batch` 把往返次数从 6 降到 1，但每步仍各自 dump，总耗时与逐条基本持平。

## 3. 用例结果明细

### 模块 A：浏览器 / H5

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| A-01 加载音乐页 | 通过 | `reverse tcp:8000` + WebView Shell 打开本机静态页；页面控件「播放」可读，`aya_current_app` 为 `org.chromium.webview_shell` |
| A-02 WebView 调试与端口 | 通过 | `localabstract:webview_devtools_remote_2277` forward 后，本机 `curl http://127.0.0.1:18081/json/version` 返回 DevTools 版本 JSON |
| A-03 播放 | 通过 | `aya_tap_text{播放}` 后 `ui.changed=true`，状态由「已暂停」变「播放中」 |
| A-04 播放/暂停/下一首 | 通过 | batch 1 次调用完成 3 次操作；逐条方式 N=3，单次 2.4–4.9 s |
| A-05 进度拖动 | 通过 | `swipe` 500 ms 后进度 00:00 → 01:53，与滑块 `input` 事件写回一致 |
| A-06 ASCII 输入 | **失败** | 输入 `aya mcp test 2026`，回读为 `啊呀买彩票test2026`（Gboard `LatinIME` 拼音转换），见 BUG-02 |
| A-07 中文输入 | 通过 | `aya_text{中文测试}` 精确返回 `INVALID_ARGS`：「输入仅支持可打印 ASCII 字符；中文等非 ASCII 文本请用 aya_shell 配合设备输入法」 |
| A-08 表单提交 | 部分通过 | 流程可跑通（batch 输入→提交→回读结果），但提交内容被 BUG-02 污染 |
| A-09 SurfaceView / Canvas 兜底 | 通过 | canvas 区域不在 UI 树（仅说明文字可读）；`aya_screencap` 正常出图，点击改用坐标 |
| A-10 媒体按键 | 通过 | `volume_up`/`volume_down`/`back` 返回 keycode 24/25/4，`settledMs` 300 |

### 模块 B：APK 开发

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| B-01 信息查询 | 通过 | 该机为纯净系统：`total:129`、`matched:0`（第三方 0 个）；`aya_app_info` 对未安装包返回 `NOT_FOUND`；`aya_device_info` 字段齐全 |
| B-02 安装 / 覆盖安装 | 阻塞 | 无专用测试 APK |
| B-03 启动 / 强停 | 部分通过 | `aya_start_app{webview_shell}` 首次调用后 `aya_current_app` 返回 `package:"" pid:0`（`mCurrentFocus=null`），`force-stop` 后重试成功（pid 3785，焦点 `WebViewBrowserActivity`）；见 BUG-12 |
| B-04 logcat 抓崩溃 | 通过 | 清空 → `am crash` → `level:E` 全量、`keyword:FATAL` 5 条、`tag:AndroidRuntime` 17 条，堆栈完整 |
| B-05 文件与目录 | 部分通过 | push/stat/list/pull 内容一致（`AYA_MCP_TEST_2026`，17 B）；`delete_path` 不带 `recursive` 报 `INVALID_ARGS`、带上后成功；**`aya_rename_path` 返回 `ok:true` 但源文件未动、目标 ENOENT**（BUG-01） |
| B-06 字体缩放 | 通过 | `1.0 → 1.3` 后同一控件 `bounds` 明显变大，`previous/scale` 正确，已恢复 1.0 |
| B-07 性能与进程 | 通过 | 8 核负载、温度 37 ℃、内存 4,086,702,080 B（已用约 1.24 GB）、电量 50 %、`foreground` 正确 |
| B-08 清数据/禁用/卸载 | 阻塞 | 无专用测试包 |

### 模块 C：BSP

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| C-01 设备属性/内核 | 通过 | `kernel 6.1.99 aarch64`；`ro.product.board=rk30sdk`、`ro.boot.hardware=rk30board`；`/proc/cmdline` 非 root 被拒且 `errorHint` 透传 |
| C-02 Shell 探测 | 通过 | `getprop`/`dumpsys meminfo`/`ls /dev/ttyS*` 均返回；`sleep 40` → `TIMEOUT`（30 s 上限）；`dumpsys meminfo \| head -30` 报 `errorHint: Broken pipe`（head 截断所致，数据有效） |
| C-03 端口映射 | 通过 | forward/reverse 增删成功；重复 add 幂等；`local:"abc"` → `INVALID_ARGS`；移除不存在的 forward → `INTERNAL`（附 adb 原文）；`all:true` 清空生效 |
| C-04 串口枚举/状态 | 通过 | `COM1`（ACPI PNP0501）+ `COM31`（CH340，VID_1A86/PID_7523）；`status` 含 open/path/baudRate/8N1/paused/sessionId/lines/seq/bytes/logFile |
| C-05 启动阶段日志 | 通过 | 复位板子两次，串口收全 `bootloader → kernel → android`；`source:bootloader` 183 行、`source:kernel` 自 seq 815、`boot_completed` 于 17.2 s 出现（总 3,983 行/次） |
| C-06 串口下发 | 部分通过 | `serial_write{data,newline:true}` 返回 `ok:true` 与 `sent`；目标控制台未启用输入回显，`serial_logs` 读不到回显；`data:""` → `INVALID_ARGS` |
| C-07 增量与等待 | 通过 | `fromSeq` 增量只返回新行；`serial_wait` 正例 `matched:true`（28.4 s 命中新行）、负例 `matched:false`/`waited:6,0xx ms`；`keyword:"[" + regex:true` → `INVALID_ARGS` |
| C-08 波特率与清空 | 通过 | `115200` 采集为乱码（波特率不匹配，工具不崩溃）；`1500000` 正常；`baudRate:100` → `INVALID_ARGS`；`clear` 后 `logFile` 变化、`seq` 归零但 **`sessionId` 不变**（BUG-10）；重复 `open` 会新建会话并更换日志文件（BUG-13） |

### 模块 D：复杂场景效率

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| D-01 batch vs 逐条 | 部分通过 | N：6 → 1；但 T 基本持平（每步仍完整 dump），未达到 ≤70 % 目标 |
| D-02 浏览器长流程 | 部分通过 | 启动→加载→点击→输入→提交→切歌→拖动→截图全链路可一次连续完成；输入内容仍被 IME 改写 |
| D-03 快照过期与错误恢复 | 通过 | `STALE_SNAPSHOT`（"快照已失效…"/"snapshotId 不匹配（当前为 …）"两种文案）、`NO_MATCH`（附候选与建议）；重新 dump 后 1 次调用即恢复，R=1 |
| D-04 wait_for vs 轮询 | 通过 | `wait_for` N=1；超时负例 `attempts:4`、`waitedMs:10,432`、回传 `nodes[]` 与截图兜底提示 |
| D-05 batch 断点恢复 | 通过 | 实测 `failedAt:0`、`executed:0`、前序动作未回滚；补一次 dump+batch 即继续，R=1 |
| D-06 录屏留证 | 通过 | 录制期间 batch 操作不受阻塞；`status` 显示已录/剩余时长；产物 26,799 ms / 99,713 B，MP4 头正确 |
| D-07 投屏与坐标口径 | 通过 | `cast_window{open/restart/close}` 的 `visible` 正确；`cast_settings` 8000000/0 → 4000000/720 持久化并可回滚；投屏开启时截图 1920×1080 缩放 0.46875，点击仍用 dump 的 `center` 设备像素且落点准确 |

## 4. 缺陷与风险清单

| 编号 | 严重度 | 问题 | 证据 | 根因定位 |
| --- | --- | --- | --- | --- |
| BUG-01 | 高 | `aya_rename_path` 假成功：返回 `ok:true`，源仍存在、目标 ENOENT | B-05 换机复现 | `src/main/lib/adb/file.ts:401` `fileShell` 只拼 `path` 丢 `dest`，且未校验 `mv` 退出码 |
| BUG-02 | 高 | `aya_text` ASCII 被输入法改写 | `aya mcp test 2026` → `啊呀买彩票test2026`，IME 为 Gboard `LatinIME` | `src/main/lib/mcp/lib/action.ts:189` 直接 `input text`，无 IME 预检 |
| BUG-03 | 中 | H5 输入框值不在 UI 树，无法回读校验 | `aya_ui_dump{text:"aya mcp test"}` → `matched:0` | WebView 可访问性不暴露 `input.value`，缺 CDP 通道 |
| BUG-04 | 中 | 每次输入后强制作废旧快照，文本定位触发完整 dump | 单次点击 2.4–4.9 s | `action.ts:46` `afterInput` 无条件 `invalidateSnapshot` |
| BUG-05 | 中 | `aya_batch` 每步独立 dump，未复用快照 | 6 步 batch 与逐条耗时持平 | `batch.ts:130` 每步 `performTap` → `ensureSnapshot` |
| BUG-06 | 中 | `aya_logcat` 先拉大段日志再本地过滤，`errorHint` 噪声大 | FATAL 查询 `errorHint` 为无关警告 | `logcat.ts:65-76`；`errorHint=detectShellError(raw)` |
| BUG-07 | 中 | 串口无 pause/resume 工具 | `status.paused` 只能靠 close/open 解除 | `tools/serial.ts` 缺工具 |
| BUG-08 | 中 | `aya_screencap` 固定 PNG base64，体积大；多显示设备未指定 display | 1920×1080 全屏 PNG；`Multiple displays found` 警告 | `tools/screen.ts:34-46` |
| BUG-09 | 低 | `aya_add_port` 重复添加静默成功，无 `existed` 标识 | 同参数连续两次均 `ok:true` | `tools/port.ts:104` |
| BUG-10 | 低 | `aya_serial_clear` 保留 `sessionId`，与"新会话"语义不符 | `sessionId` 不变、`logFile` 变、`seq` 归零 | serial 模块 clear 实现 |
| BUG-11 | 低 | `aya_cast_window` 不接受 `deviceId`，与其余工具不一致 | schema `additionalProperties:false` | `tools/cast.ts:81` |
| BUG-12 | 高 | `aya_start_app` 冷启动后首次 `aya_current_app` 为空 | 返回 `package:"" pid:0`、`mCurrentFocus=null`；`am start -W` 直连 `Status: ok`，重试成功 | 启动后未轮询窗口焦点/`ensureSnapshot` 时序竞态（`package.ts` `startPackage`） |
| BUG-13 | 低 | 重复 `aya_serial_open` 直接覆盖会话并更换日志文件 | `serial1→serial6`，`status.logFiles` 仅回最新 1 个，旧文件只在磁盘残留 | serial 模块 open 未做占用检查，`logFiles` 未回传历史 |
| BUG-14 | 低 | 串口波特率未按 schema 枚举校验 | `baudRate:1000000` 被接受（schema 枚举外但 handler 允许） | schema 与 handler 校验范围不一致 |

> 已确认非缺陷：`dumpsys meminfo | head -30` 的 `Broken pipe` 是管道被 head 提前关闭导致的 stderr，属预期现象。

## 5. 结论

1. **核心链路可用**：换机后 33 条用例复测，24 通过、6 部分、1 失败、2 阻塞，与上一轮结论一致；设备/应用/文件/日志/串口/端口/录屏/投屏全部打通。
2. **串口是 BSP 场景不可替代的通道**：`aya_serial_*` 采集到 7,968 行、1 MB 的真实开机日志，`bootloader/kernel/android` 分段准确，`boot_completed` 于 17.2 s 命中；该能力 adb logcat 无法提供。使用要点：波特率必须与板子一致（本机 1,500,000，115200 会得到乱码）。
3. **效率瓶颈在 dump**：单次 dump 2.4–4.9 s，是点击（120–300 ms）的一个数量级以上；`aya_batch` 只省往返不省时间，`aya_wait_for` 是唯一能压掉轮询次数的工具。
4. **必须优先修的两个正确性缺陷**：`aya_rename_path` 假成功（数据安全隐患）、`aya_start_app` 冷启动竞态（自动化脚本首步易失败）；`aya_text` 受 IME 改写仍是 H5 场景最大正确性风险。
