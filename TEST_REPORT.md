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

## 6. 专项复测：播放器快进 / 播放 / 手势注入

### 6.1 环境与口径

| 项 | 值 |
| --- | --- |
| 被测应用 | `com.tudou.video`（前台播放页） |
| 设备 | 1920×1080，density 140（physical 160），单显示 |
| 应用窗口 | 1421×1031（`playerContainer` 从 y=21 起），dump 坐标即注入坐标 |
| 视频时长 | 1:51:50（6710 s） |
| 进度条 | `seekBar` 轨道 x=12→1409，触摸 y≈972 |
| 涉及工具 | `aya_gesture`（多段注入）、`aya_batch`（新增 `gesture` 步骤）、`aya_tap`、`aya_ui_dump`、`aya_shell` |

### 6.2 用例结果

| 用例 | 结果 | 实测数据 |
| --- | --- | --- |
| 快进 10 % | 通过 | 00:41 → 11:12（期望 11:11，偏差 +1 s） |
| 快进 30 % | 通过 | → 33:34（期望 33:33，偏差 +1 s） |
| 快进 50 % | 通过 | 23:01 → 55:57（期望 55:55，偏差 +2 s） |
| 快进 90 % | 通过 | → 1:40:42（期望 1:40:39，偏差 +3 s） |
| 快退 | 通过 | 1:40:42 → 22:32（期望 22:22，偏差 +10 s），app 弹出“快退中” |
| 方向提示 | 通过 | 前进拖动 `appeared` 含“快进中”，并显示预览时间 `04:47` |
| 暂停 | 通过 | 22:56 冻结（间隔 3 s 两次读取一致，`desc="播放"` 不变） |
| 恢复播放 | 通过 | 22:56 → 23:01 |
| 单段手势“唤醒 + 拖动” | 通过 | 1:40:42 → 22:32，`gestureMs=599`，一次调用完成 |
| 单段手势“唤醒 + 点按钮” | 通过 | 22:43 冻结，`(1268,1004)` 中心点即生效 |
| `aya_batch` 手势“唤醒 + 快进” | 通过 | 一次调用 `totalMs=2,709`，`executed:2`、`gestureSteps:5`，落到 1:18:18（期望 1:18:17，偏差 +1 s）；重建重启后复验 `totalMs=2,848`（其中 `ui:full` dump 492 ms）、`gestureMs=684`、落点仍为 1:18:18 |
| `aya_batch` 手势“唤醒 + 暂停” | 通过 | 1:18:18 冻结，间隔 3 s 两次采样 `tvTime` 一致 |
| 暂停态恢复 | 通过 | 同一段手势内连点两次 `btnPlayPause` 会被吞；改为另起一次调用点 `btnCenterPlay (711,525)` 或 `aya_tap (1268,1004)` 即恢复（1:18:57 → 1:19:01） |
| 分段延时注入 | 通过 | 5 步 `down/move/move/up`，延时 60+300+70+70+110 ms 全部按序生效 |
| 同排 `btnSpeed` 点击 | 通过 | `(1313,1003)` → 弹出倍速面板（1X/1.25X/…） |
| 媒体键 `KEYCODE_MEDIA_PLAY_PAUSE` | 不适用 | `input keyevent 85` 无响应，该 app 未监听媒体键（非 AYA 缺陷） |

### 6.3 关键约束（使用要点，务必写进工具说明）

1. **控制栏 3 s 自动隐藏**：一次模型往返 1.5–3 s，几乎必然错过窗口。唤醒与操作必须放进**同一段 `aya_gesture`**：
   `down/up(视频区) → down(目标控件, delayMs≈300) → up`，实测稳定生效。
2. **重复点视频区会关闭控制栏**：脚本需先 `aya_ui_dump` 判断 `btnPlayPause` 是否存在，可见则直接点，不可见才补唤醒点。
3. **`btnPlayPause` 的 `desc` 恒为“播放”**，不能用来判断状态；判定播放/暂停只能用 `tvTime` 两次采样是否变化。
4. **进度落点公式**：`x = 12 + 1397 × pct`（pct 为 0–1），实测线性、误差 ≤0.15 %。
5. 早前记录的“按钮中心无效、仅底部有效”为**误判**，真实原因是控制栏在跨调用等待期间已隐藏/滑入动画未完成；同手势内点中心 `(1268,1004)` 正常。
6. **暂停与恢复要分开做**：同一段手势里连点两次 `btnPlayPause`，第二次会被吞掉；暂停一次手势即可，恢复需另起一次调用点 `btnCenterPlay (711,525)` 或 `btnPlayPause (1268,1004)`。
7. **优先用 `aya_batch` 的 `gesture` 步骤**：整段手势 + 后续 `wait`/取样可放在一次调用内（实测唤醒+快进 `totalMs=2,709`），比 `aya_gesture` + 额外调用更抗中间态。

### 6.4 新发现缺陷

| 编号 | 严重度 | 状态 | 问题 | 证据 | 根因定位 |
| --- | --- | --- | --- | --- | --- |
| BUG-15 | 中 | 已修复 | `aya_batch` 不支持 `gesture` 步骤，无法原子执行“唤醒控制栏→拖动/点击” | 修复前：拆成两次调用约 60 % 概率落在隐藏窗口外（60 % 快进失败、进度停在 33:34）；修复后：一次调用 `totalMs=2,709`、`executed:2`、`gestureSteps:5`，落到 1:18:18（偏差 +1 s） | `tools/batch.ts` 原仅 `tap/tap_text/swipe/key/text/wait` |
| BUG-16 | 低 | 已修复 | `aya_gesture` 未在描述中说明“一段手势可包含多组 down/up”，导致“轻点唤醒 + 拖动”能力不可发现 | 5 步手势含两次 down/up 实测可用（tap 后 280 ms 再 down）；描述已补示例 | `tools/gesture.ts` 校验只要求首步 down、末步 up，本身允许多组 |

**BUG-15 修复实现**（`src/main/lib/mcp/tools/batch.ts`）：

- `stepSchema.action` 枚举加入 `gesture`，新增 `steps` 子数组（`down/move/up/cancel` + `x/y/delayMs`），与 `aya_gesture` 同构；
- `case 'gesture'`：`normalizeSteps(step.steps)` 复用同一套校验 → `withDeviceQueue` → `injectGesture(captureAt:-1)` → `settle` → `invalidateDump`，保证后续步骤读到手势后的界面树；
- 复用了 `tools/gesture.ts` 中导出的 `normalizeSteps`，两个工具的手势校验口径一致。

## 7. 第三轮回归：常驻注入 / ACTION_SET_TEXT / 设备端截图 / 无障碍事件（2026-10-27）

设备：RK3576 / Android 14（`4a7de4f19facc740`），AYA dev 模式（`electron .`），主进程与 `aya.dex` 均为本轮构建。

### 7.1 实测数据

| 项 | 结果 | 说明 |
| --- | --- | --- |
| UI dump | 平均 176 ms（6 次，47–319 ms） | `source:"accessibility"`；上一版 `uiautomator dump` 为 2.4–4.9 s |
| `aya_tap` | 699 ms（含 id 定位 dump + settle 300 ms） | `via:"uiAutomation"` |
| `aya_batch` 4 步 | 857 ms；单步 tap 227/233 ms、key 156/171 ms | 注入本身约 100 ms / 40 ms |
| `aya_text`（中文 + emoji） | 638 ms | `via:"setText"`、`previousText:"搜索…"`、`verify.matched:true` |
| `aya_text`（`clear:false` 追加） | 520 ms | `cleared:"appended"`、`verify.matched:true`，最终内容「你好 AYA 中文测试 🚀 追加123」 |
| `aya_swipe` | 515 ms（含 300 ms 滑动时长） | `via:"uiAutomation"` |
| `aya_screencap` | 333 ms / 15,128 B（900×506 JPEG） | `source:"uiAutomation"`、`shotMs:172`；`width/height` 仍为 1920×1080、`scale:0.46875` |
| `aya_ui_watch` | 命中 `content` 事件（`count:3`），等待 11.7 s 后被设备侧动作唤醒 | 事件合并生效 |
| `aya_wait_for`（超时） | `mode:"events"`、`eventsSeen:0`、`attempts:1`、dump 47 ms | 上一版同场景 attempts 7、dump 627 ms |
| `aya_wait_for`（事件唤醒） | `eventsSeen:1`、`attempts:2`（事件后仅复核一次） | 界面不含目标文本，未命中，但唤醒链路正常 |
| `aya_stats` | 10 次调用、0 错误 | dump 平均 176 ms |

### 7.2 本轮修复

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 冷启动首次注入降级 | 设备端服务刚重启时 `via:"shell"`、耗时 10.5 s | `AyaClient.isRunning` 去掉 `singleton`（首次 false 被缓存会让 `waitUntil` 必然超时）；`injectOrFallback` 失败后 400 ms 重试一次再熔断 |
| `via` 未透出 | 返回里没有 `via`，无法判断走注入还是 shell | `input.ts` / `gesture.ts` 的 tap、swipe、key、text 全部透出 `via` |
| 截图 meta 语义错误 | `width/height` 变成缩放后尺寸、`scale` 恒为 1 | 用设备端返回的 `sourceWidth/Height` 作为设备像素，`scale` 据此计算 |
| 追加输入 verify 误报 | `clear:false` 后 `verify.matched:false` | `performText` 返回 `expectedText`，verify 按最终内容比对 |
| 等待期间空 dump | 事件模式下每次 watch 超时仍 dump 一次（attempts 17） | 无事件时跳过 dump 直接继续等（attempts 1） |

### 7.3 结论

- 注入 / 文本 / 截图三条常驻通道全部生效，失败可降级且用 `via` / `source` 标明实际路径。
- 无障碍事件通道可用，`aya_ui_watch` 与 `aya_wait_for` 的事件唤醒实测通过；界面静止时不再空转 dump。
- 已知限制：事件唤醒依赖界面真的产生无障碍事件，SurfaceView / 视频画面不会产生，仍走超时逻辑。
- 测试期间出现过一次「两个 AYA 主进程并存导致端口占用、旧进程代码回应请求」的环境问题，清理后复测通过，与代码无关。

## 8. 同板对比：AYA MCP vs uiautomator2（2026-10-27）

设备：RK3576 / Android 14（`4a7de4f19facc740`），两者在**同一台设备、同一界面（设置首页 / 搜索页）**上交替测量。

- u2 侧：Python 3.12 + `uiautomator2`（atx-agent + uiautomator stub），脚本 `script/bench/bench_u2.py`
- aya 侧：直连 MCP HTTP 端点（`POST /mcp` + Bearer Token），不经过 AI 客户端，脚本 `script/bench/bench_aya.mjs`
- 每个用例 10–20 次取 avg / p50 / p95；aya 的 dump 采样间隔 1.1 s（避开 1 s 缓存，保证每次都是真实 dump）

### 8.1 前置结论：两者互斥，不能同时占用设备

aya 的常驻 UiAutomation 与 uiautomator2 的 UiAutomation 争抢同一个无障碍连接槽位：

| 现象 | 证据 |
| --- | --- |
| aya 设备端服务在跑时，u2 启动 stub 失败 | `java.lang.IllegalStateException: UiAutomation not connected` |
| 停掉 aya 设备端服务后 u2 立即可用 | `pkill -f io.liriliri.aya.Server` → `dump_hierarchy` 155 ms 成功 |
| 反向同理 | u2 的 atx-agent 存活时 aya 注入会回退到 shell |

因此基准必须轮流跑，工程上二者只能择一使用。

### 8.2 实测对比

| 用例 | uiautomator2 | AYA MCP | 差异 |
| --- | --- | --- | --- |
| UI 层级（各自默认口径） | 309.2 ms / 93,484 B（compressed XML） | **131.5 ms / 3,936 B**（紧凑 JSON） | 2.35× 快 / 23.7× 小 |
| UI 层级（原始 XML 同口径） | 309.2 ms / 93,484 B | **179.5 ms / 83,678 B** | 1.72× 快 / 10% 小 |
| 点击（坐标） | 180.2 ms | **90.8 ms** | 1.98× 快 |
| 滑动（300 ms 动作时长） | 1160.2 ms | **390.0 ms** | 2.98× 快 |
| 文本写入 | 252.8 ms（send_keys）/ 475.7 ms（set_text） | **92.6 ms**（ACTION_SET_TEXT） | 2.7–5.1× 快 |
| 截图 | **145.3 ms / 6,220,800 B**（PNG） | 161.5 ms / **14,256 B**（JPEG 900px） | 耗时相当，体积 436× 小 |
| 按控件定位点击 | 937.3 ms（resourceId） | **338.2 ms** | 2.77× 快 |
| 按文本定位点击（中文） | 匹配失败（Windows 版 u2 请求编码问题） | **62.4 ms** | — |

### 8.3 差异来源

1. **注入路径**：aya 走常驻 UiAutomation 的 `injectInputEvent`（一次 binder）；u2 的 click/swipe 经 atx-agent jsonrpc，swipe 默认 10 步插值、每步一次 HTTP 往返，300 ms 的滑动因此花了 1160 ms。
2. **定位方式**：u2 每次 `d(...)` 都是一次 jsonrpc 节点查找 + 隐式等待；aya 在主机侧一次 dump 解析出紧凑节点表并缓存快照（`snapshotId` 60 s），命中缓存时不再 dump。
3. **传输与解析**：u2 返回整棵 XML（93 KB），aya 默认返回裁剪后的紧凑 JSON（3.9 KB），省掉一次 XML 解析与大量 token。
4. **截图**：u2 拿到原始 PNG（6.2 MB）后自行处理；aya 在设备端缩放 + JPEG 压缩，只回 14 KB。
5. **文本**：aya 的 `ACTION_SET_TEXT` 一次 binder 写入并绕过 IME；u2 的 `send_keys` 走输入法、`set_text` 需要先定位节点。

### 8.4 可提升区间（aya 侧）

| 用例 | 当前 | 剩余主要开销 | 理论下限 | 可提升 |
| --- | --- | --- | --- | --- |
| UI 层级 | 131.5 ms | AccessibilityNodeInfo 遍历 + 序列化（213 节点裁到 100） | ~80 ms | 20–40% |
| 点击 | 90.8 ms | RPC + 注入 + settle | ~40 ms | 30–50% |
| 滑动 | 390 ms | 其中 300 ms 是动作时长本身 | ~320 ms | <10%（已接近下界） |
| 文本写入 | 92.6 ms | 一次 ACTION_SET_TEXT + 焦点查找 | ~60 ms | 20–30% |
| 截图 | 161.5 ms | `takeScreenshot` + 缩放 + JPEG（设备端 172 ms） | 30–80 ms（minicap / 复用投屏视频流截帧） | 2–4× |
| 按控件定位点击 | 338.2 ms | 定位需要一次 dump（~130 ms） | 50–80 ms（用 nodeIndex 复用快照） | 3–4× |

另外，aya 侧「点击 + 观察」可一次调用完成（`aya_tap` 默认回传新界面），在 agent 场景等于省掉一次「点击 → dump → 解析」往返；u2 需要 AI 自己写代码再解析 XML。**上下文成本差距比毫秒差距更大**：一次层级读取，aya ≈1.2k tokens，u2 ≈30k tokens。

### 8.5 结论

- 同板实测，AYA MCP 在注入、定位、文本、层级四项快 1.7–5 倍；截图耗时持平但回传体积小 436 倍。
- u2 的优势在脚本化：一次 Python 循环能跑上百步且不经过模型往返，适合固定回归；AYA 的优势在模型即席操作：无需生成代码、无需安装依赖，结果直接可被模型消费。
- 两者不能同时占用设备端无障碍连接，同一时刻只能选一个。
- u2 在 Windows 上还有中文 selector 编码问题（`text='搜索'` 匹配不到），aya 侧无此问题。

### 8.6 低风险优化项落地（同日）

基于 8.4 的可提升区间先做两项低风险改动，并复测：

| 项 | 改动 | 结果 |
| --- | --- | --- |
| 截图不再二次编码 | 设备端已按目标宽度缩放并压成 JPEG，主机直接透传字节（原实现又解码 + 重编码一次，1080p 约 20–30 ms） | 平均 **161.5 → 140 ms**（p50 148 → 137），18.5 KB，meta 正确（1920×1080 / 900×506 / scale 0.46875 / `source:"uiAutomation"`） |
| tap 按压时长可配 | 新增 `pressMs`（默认 20），`Ui.kt` 用它决定 up 事件的 eventTime 偏移 | **无性能差异**（pressMs=0 为 91.5 ms，pressMs=20 为 89.1 ms）：`injectInputEvent(sync=false)` 不等待应用消费，那 20 ms 只是事件时间戳偏移而非真实等待。参数保留，供个别对 down/up 间隔敏感的应用使用 |

其余分支复测正常：`crop` 205 ms、`format:"png"` 163 ms、adb 降级路径 meta 与裁剪语义均未变。

**第 2 项「设备端裁剪后再传输」经复核后推迟**：aya 的 `snapshot` 同时是「对外输出」和「内部节点匹配源」——`target.ts` 的定位、`captureUi` 的差异比较、`pickActionable` 的可点击节点都基于同一棵 `flat`。若在设备端裁剪节点或属性，主机侧 `flat` 会变稀疏，定位会漏掉被裁掉的控件；而为了对外与内部各取一份又得多一次 dump，反而更慢。该优化需与「设备端按选择器直查」配套推进（定位不再依赖整棵树之后，dump 才退化为纯对外输出）。

**BUG-16 修复实现**（`src/main/lib/mcp/tools/gesture.ts`）：`aya_gesture` 描述改为“一段事件流内可包含多组 down/up”，并给出“轻点唤醒 + 拖动进度条”的 5 步示例；`steps` 字段描述同步说明每组独立成对。

> 未遗留建议项：两条缺陷均已随 v2.2.1 之后的本地构建落地（`tools=72`，`aya_batch` 枚举含 `gesture`）；重建重启后 `tools/list` 实测 `aya_gesture.description` 已含“一段事件流内可包含多组 down/up”与 5 步示例、`steps` 字段说明同步更新，真机复验快进落点仍为 1:18:18。
