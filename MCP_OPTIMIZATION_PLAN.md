# AYA MCP 优化方案（基于真机测试结果）

> 输入：`TEST_REPORT.md`（2026-10-24，RK3576 / Android 14）
> 目标：修复正确性缺陷，并把 AI 调用效率提升一个数量级
> 原则：接口向后兼容；先修正确性，再降延迟，最后做架构升级

## 1. 一句话结论

当前 MCP 的瓶颈不在协议、不在点击，而在**每条文本动作都要执行一次 2.5–5.3 s 的 uiautomator dump**：

- `afterInput` 每次输入后无条件作废快照（`action.ts:46`），下一次文本定位必须重新 dump；
- `aya_batch` 每一步独立 dump（`batch.ts:130`），所以只省往返、不省时间（实测 12.31 s vs 12.33 s）；
- `aya_wait_for` 每次尝试也是一次完整 dump（实测 3 次尝试 7.9 s）；
- H5 场景没有 CDP 通道，读输入框、点 DOM、等元素都只能走 UI 树。

因此优化主线是：**减少 dump 次数 → 让 dump 只在必要时发生 → 为 H5 提供毫秒级 CDP 旁路**。

## 2. 量化基线与目标

| 场景 | 实测现状 | 优化目标（预期） | 主要手段 |
| --- | --- | --- | --- |
| 连续 3 次文本点击 | 12,329 ms / 3 次往返 | ≤ 6,500 ms / 1–3 次往返 | 快照复用 + 坐标点击（P0-3） |
| 3 步 `aya_batch` | 12,310 ms / 1 次往返 | ≤ 6,500 ms | 批次内一次解析（P0-4） |
| 单次「点击 + 看结果」 | 2.7–5.4 s | ≤ 1.5 s | `withUi` 分级、默认节点数下调（P0-5） |
| H5 点击/读值/等元素 | 2.8 s / 次 | 50–200 ms | WebView CDP 工具集（P1-1） |
| logcat 抓 FATAL | 拉 1,000 行，命中 1 条 | 设备端过滤，仅回传命中 | `logcat -s/--pid`（P0-6） |
| 截图 | 1.5 MB PNG base64 | ≤ 400 KB JPEG 或返回文件路径 | 格式/裁剪/saveTo（P1-2） |
| `aya_rename_path` | 100% 假成功 | 100% 真实成功或报错 | 修 `fileShell`（P0-1） |
| ASCII 输入（CJK 输入法） | 内容被改写 | 原样输入 | IME 预检/切换（P0-2） |

> 表中「目标」为改造后的验收阈值，不是当前实测值。

## 3. P0：正确性与最大收益（先做）

### P0-1 修复 `aya_rename_path` 假成功

**问题**：`src/main/lib/adb/file.ts:376-402` 的 `fileShell` 在非 `/data/data/` 分支只拼了 `path`，把 `dest` 丢了：

```ts
// 现状
return shell(deviceId, `${cmd} "${path}"`)
```

`mv` 只收到一个参数，必然失败；但 `moveFile` 不检查输出，`aya_rename_path` 直接返回 `ok:true`。

**修改**

```ts
const target = dest ? ` "${dest}"` : ''
const output = await shell(deviceId, `${cmd} "${path}"${target}`)
assertShellOk(output, `aya_${cmd}`)
return output
```

同时 `moveFile` 在移动后 `statFile(dest)` 校验存在，失败抛 `INTERNAL`。`aya_delete_path`、`aya_make_dir` 也统一走 `assertShellOk`，避免同类假成功。

**收益**：B-05 从部分通过 → 通过；避免 AI 基于假成功继续后续步骤。
**验收**：重跑 B-05，`stat_path` 源不存在、目标存在且内容一致。

### P0-2 修复 `aya_text` 被输入法改写

**问题**：`action.ts:189-209` 用 `input text` 注入，当前 IME（Gboard 拼音）会把 `aya mcp` 转成「啊呀买彩票」。

**修改**（按优先级）

1. **IME 预检**：`settings get secure default_input_method`；若非拉丁键盘，自动 `settings put secure default_input_method` 切到 `com.android.inputmethod.latin/.LatinIME`（或 ADBKeyboard），输入后恢复原值。参数 `ime: "auto" | "keep"`，默认 `auto`，写操作需显式开启。
2. **ADBKeyboard 优先**：检测到 `com.android.adbkeyboard` 时用广播 `ADB_INPUT_TEXT`，可同时解决中文。
3. **输入后回读**：返回 `focused` 节点的 `text`（一次 dump）或 `verify:false` 跳过；H5 用 CDP 读 `input.value`（P1-1）。
4. **清空能力**：`clear:true` 时先 `KEYCODE_MOVE_END` + 循环 `KEYCODE_DEL`，避免追加。
5. **失败提示**：IME 切换失败时返回 `WRITE_DISABLED`/`INTERNAL` 并说明原因，不要静默写入错误内容。

**收益**：A-06/A-08 从失败 → 通过；中文输入具备可用替代路径。
**风险**：切换 IME 影响设备全局状态，必须原值恢复并在描述中提示。

### P0-3 快照复用：输入后不立即作废

**问题**：`action.ts:46-56`

```ts
export async function afterInput(deviceId, settle = 300) {
  invalidateDump(deviceId)
  invalidateSnapshot(deviceId)   // 每次输入都作废
  ...
}
```

`target.ts:22-31` 的 `ensureSnapshot` 只有在快照存在时才能免 dump。实测因此每次文本点击都多花 2.5–5.3 s。

**修改**

1. `afterInput` 改为**标记**而非删除：`snapshot.staleSince = Date.now()`，保留 `flat` 节点与坐标。
2. 新增屏幕指纹：`windowFocus` + `bounds` 哈希（或 `dumpsys window` 的 `mCurrentFocus` + 根节点 `bounds`），输入后异步采样一次。
3. `aya_tap`/`aya_batch` 新增 `reuseSnapshot`（默认 `"auto"`）：
   - `auto`：若目标选择器在旧快照中存在，且指纹未变，则直接用旧坐标点击，不 dump；
   - `strict`：始终重新 dump；
   - 命中后若 `withUi:true`，用一次抓帧确认并刷新快照。
4. `aya_ui_dump` 返回 `expiresAt` 与 `stale`，让 AI 明确何时需要重抓。

**预期收益**：3 次连续文本点击 12.3 s → 3.5–6.0 s（只 dump 一次）。
**风险**：动画/列表滚动会导致旧坐标失效。缓解：指纹校验 + `reuseSnapshot:"strict"` 兜底 + 点击后 `ui.changed` 校验。

### P0-4 `aya_batch` 批次内一次解析

**问题**：`batch.ts:120-205` 每一步 `performTap` 都会 `ensureSnapshot`；3 步 9.8 s，终帧再 2.5 s。

**修改**

1. 新增 `resolveOnce`（默认 `true`）：
   - 批次开始时 dump 一次，把所有 `tap_text/tap/id/desc` 步骤解析为坐标；
   - 依次执行坐标点击（`x/y` 路径，`target.ts:70-79` 已验证不触发 dump）；
   - 若某步解析失败，回退到该步单独 dump（保持现有失败语义）。
2. 每步新增 `dump: false`，默认 `false`；只有显式 `dump:true` 或 `withUi` 时才抓帧。
3. `ui` 参数改为 `"none" | "diff" | "full"`，默认 `diff`（只回 `appeared/disappeared`），终帧 `uiMaxNodes` 默认 20。
4. 明确 `failedAt` 为 **0 基索引**（写入 schema description，避免 AI 误判）。

**预期收益**：3 步 batch 12.3 s → 3.5–6.5 s；输出 token 显著下降。
**验收**：D-01 达到 `T(batch) ≤ T(逐条) × 0.6`，N=1。

### P0-5 `withUi` 分级与默认值收敛

**问题**：`input.ts:36` 默认 `withUi:true`，每次点击固定 +2.5–5.3 s；`uiMaxNodes` 默认 60，输出冗长。

**修改**

- 保留默认 `true`（易失控件场景需要），但在 description 中写明实测成本，并新增 `withUi: "auto"`：仅当 `settle` 后检测到界面变化（轻量指纹）才抓帧。
- `uiMaxNodes` 默认 60 → 20；`aya_wait_for.maxNodes` 40 → 20；`aya_ui_dump.maxNodes` 300 → 100，并支持 `cursor` 分页。
- 所有 UI 返回增加 `timing: { dumpMs, actionMs, captureMs }`，让 AI 自行选择更便宜的参数。

**收益**：单次点击+观察从 2.7–5.4 s 降到约 1.5 s；输出 token 降低约 60%。

### P0-6 logcat：设备端过滤 + 崩溃摘要 + 等待工具

**问题**：`logcat.ts:60-88` 有过滤条件时先抓 `lines*20`（上限 5000）再本地过滤（实测 1000 行）；`errorHint` 取原始输出首条错误，FATAL 查询时返回的是 HwcComposer 噪声。

**修改**

1. 设备端过滤：`logcat -d -v threadtime -t <n> -s <tag>:<level>`；有关键字时用 `grep -i` 在设备侧先筛（或 `--pid`）。
2. `errorHint` 只在命中 `FATAL EXCEPTION / ANR in / java.lang.*Exception` 时设置；新增 `summary: { fatal, anr, process, exceptionClass }`。
3. 新增 `aya_logcat_wait { keyword|tag|pid, timeout }`：内部短轮询 `logcat -d -t 200`，命中即返回；替代「清空→操作→再查」的多次往返。
4. 新增 `since`（时间戳）与 `pid` 参数。

**收益**：崩溃定位从「拉 1000 行」降到「回传 13 行」，传输/解析量下降约 98%；AI 少一次往返。
**验收**：重跑 B-04，`fetchedLines` 与 `returned` 接近，`errorHint` 不再出现 HwcComposer。

### P0-7 串口：补齐 pause/resume 与自动波特率

**问题**：实测 `paused:true` 时无任何 MCP 工具可恢复，只能 close/open（`serial.ts` 无 pause/resume）；`baudRate` 仅接受 5 个枚举值，无自动探测。

**修改**

1. 新增 `aya_serial_pause` / `aya_serial_resume`（或 `aya_serial_open { resume:true }`）。
2. `aya_serial_open` 支持 `baudRate:"auto"`：依次尝试 1500000/921600/115200/460800，按可打印字符比例与已知关键字（`Booting Linux`、`init:`、`boot_completed`）打分，返回 `detectedBaudRate` 与 `confidence`。
3. 新增 `aya_serial_stages`：返回 `bootloader/kernel/android` 的 `startSeq/endSeq/durationMs`，避免 AI 拉全量日志自行切分。
4. `aya_serial_clear` 返回 `sessionId` 是否变化（当前保留 sessionId，语义需在文档与返回中说明）。
5. `aya_serial_write` 增加 `sentBytes` 与可选 `waitForEcho`；`status` 增加 `txBytes`（当前 `bytes` 仅接收）。

**收益**：BSP 场景从「必须重启串口」变成一键恢复；阶段日志读取量下降一个数量级。
**验收**：C-06/C-08 通过；`paused` 可双向切换；auto 波特率能识别 1500000。

## 4. P1：H5 与采集效率

### P1-1 WebView CDP 工具集（H5 场景最大杠杆）

**背景**：`aya_list_webviews` 已能拿到 `webSocketDebuggerUrl`（实测可用），但只用于人工调试。Electron 主进程可直接连 CDP。

**新增工具**

| 工具 | 作用 | 关键实现 |
| --- | --- | --- |
| `aya_webview_eval` | 执行 JS 并返回值 | CDP `Runtime.evaluate`（`returnByValue:true`） |
| `aya_webview_wait` | 等选择器出现/消失 | `Runtime.evaluate` 轮询 `document.querySelector` |
| `aya_webview_click` | 点击 DOM 元素 | `Runtime.evaluate` + `element.click()`，必要时 `Input.dispatchMouseEvent` |
| `aya_webview_input` | 设置输入框值并触发事件 | `value=...; dispatchEvent(new Event('input'))` |
| `aya_webview_navigate` | 打开/刷新 URL | `Page.navigate` / `Page.reload` |
| `aya_webview_console` | 拉取 console 与异常 | `Runtime.enable` + 事件缓冲 |

**收益**：H5 点击/读值/等元素从 2.8 s → 50–200 ms（预期）；可回读 `input.value`，解决 BUG-03。
**门槛**：仅对开启 WebView 调试的应用可用（`WebView.setWebContentsDebuggingEnabled(true)`）；默认只读，写操作受「允许写操作」控制。
**降级**：CDP 不可用时自动回退到现有 UI 树路径。

### P1-2 截图接口瘦身

**问题**：`screen.ts:32-46` 固定 PNG base64；实测 1.5 MB；多显示设备未指定 display（`screencap` 警告）。

**修改**

- `format: "png" | "jpeg"`、`quality`（默认 70）：`nativeImage.toJPEG(quality)`。
- `crop: { x, y, width, height }`：只回传目标区域。
- `saveTo`: 保存到本机并返回路径（不把 base64 塞进模型上下文）。
- `displayId`：透传 `screencap -d`；新增 `aya_list_displays`。
- 响应增加 `displayId`、`rotation`。

**收益**：单图体积预计降到 200–400 KB（JPEG q70，预期）；AI 视觉 token 明显下降。

### P1-3 UI dump 结构化与分页

- 新增 `fields`（如 `["id","text","center"]`）与 `compact:true`，去掉重复字段。
- 新增 `diffFrom: snapshotId`：只回 `appeared/disappeared/changedBounds`。
- 新增 `cursor` 分页，先回 100 条，需要时再取；避免一次返回数百节点。
- 返回 `dumpMs`、`expiresAt`、`fingerprint`。

### P1-4 `aya_wait_for` 降耗

- 自适应 `interval`：`max(interval, lastDumpMs * 0.5)`，避免 dump 2.5 s、间隔 250 ms 的无效空转。
- 先在原始 XML 上做子串预检（不解析成树），命中后再完整解析。
- 支持 `ui:"none"`，超时才回节点。
- 返回 `dumpMs` / `attempts` / `waitedMs` 的完整分解。

### P1-5 应用管理增强

- `aya_start_app`：新增 `waitFor: {text|id}`、`timeout`，默认等待前台焦点（当前固定 settle 800 ms，实测需 1500 ms）。
- `aya_install_app`：新增 `replace`（`-r`）、`downgrade`（`-d`）、`grant`（`-g`）、`user`；解析 `pm install` 输出返回 `packageName`；支持设备端 apk 路径。
- `aya_uninstall_app`：新增 `keepData`。
- `aya_app_info`：补 `apkSize`、`signature`（调试签名校验）。

### P1-6 适配测试工具（APK/BSP 共性需求）

新增一组与 `aya_set_font_scale` 同构的轻量工具，全部返回 `previous/current`：

| 工具 | 底层 |
| --- | --- |
| `aya_set_rotation` | `settings put system user_rotation` / `accelerometer_rotation` |
| `aya_set_density` | `wm density` |
| `aya_set_resolution` | `wm size` |
| `aya_set_locale` | `settings put system system_locales`（需重启应用） |
| `aya_set_dark_mode` | `cmd uimode night yes/no` |
| `aya_set_animation_scale` | `settings put global *_scale` |
| `aya_list_displays` | `dumpsys display` 解析 |

**收益**：横竖屏/多分辨率/深色模式/多语言适配从「多次 adb shell」变成一次结构化调用。

## 5. P2：架构级优化

### P2-1 设备端事件驱动 UI（替代轮询 dump）

当前每次 dump 是 `uiautomator dump --compressed`（实测 2.5–5.3 s）。可在 `aya.dex` 中增加一个 `AccessibilityService`，通过现有 Wire socket 推送：

- `TYPE_WINDOW_STATE_CHANGED` / `TYPE_WINDOW_CONTENT_CHANGED` 事件（毫秒级）；
- 节点树增量（按 `sourceNodeId` 路径）；
- `aya_ui_watch` 工具：订阅事件直到条件命中，避免 `wait_for` 的多次 dump。

预期把「等元素」从秒级降到 100 ms 级，是 D-04 的终极解。成本较高，需处理权限、进程存活、事件风暴合并。

### P2-2 屏幕指纹与节点缓存

- 以「前台 window + 根节点 bounds + 可交互节点签名」生成 `fingerprint`；
- 输入后只更新 `staleSince`，指纹不变则复用坐标；
- 缓存按 LRU 保留最近 N 帧，支持 `diffFrom`。

### P2-3 统一结果协议 v2

所有工具返回统一附加字段：

```json
{
  "ok": true,
  "timing": { "dumpMs": 2680, "actionMs": 120, "captureMs": 0, "totalMs": 2800 },
  "cost": "high",
  "snapshot": { "id": "...", "expiresAt": 1792804700000, "stale": false },
  "suggestedNextCall": { "tool": "aya_tap", "args": { "text": "暂停" } },
  "retryable": false
}
```

- `suggestedNextCall` 让 AI 在错误/成功后少一次推理；
- `cost` 让 AI 优先选低开销路径；
- `retryable` 区分瞬时失败（DUMP_FAILED）与参数错误。

### P2-4 可观测性

- 新增 `aya_stats`（只读）：按工具统计 `p50/p95` 耗时、dump 次数、失败码分布。
- 主进程日志记录每次工具调用的 `timing`，便于回归对比。

## 6. 接口变更清单

| 工具 | 变更 | 兼容性 |
| --- | --- | --- |
| `aya_tap` / `aya_tap_text` | `reuseSnapshot`、`withUi:"auto"`、`uiMaxNodes` 默认 20、`fields` | 向后兼容 |
| `aya_batch` | `resolveOnce`、每步 `dump`、`ui` 三档（none / diff / full）、明确 `failedAt` 0 基 | 默认行为变化需在 CHANGELOG 标注 |
| `aya_ui_dump` | `fields`、`diffFrom`、`cursor`、`expiresAt`、`fingerprint` | 向后兼容 |
| `aya_wait_for` | `ui`、自适应 `interval`、`dumpMs` | 向后兼容 |
| `aya_screencap` | `format`、`quality`、`crop`、`saveTo`、`displayId` | 向后兼容 |
| `aya_text` | `clear`、`ime`、`verify` | 默认 `ime:"auto"` 需谨慎 |
| `aya_logcat` | `pid`、`since`、`summary`；新增 `aya_logcat_wait` | 向后兼容 |
| `aya_serial_*` | `pause`/`resume`、`baudRate:"auto"`、`stages`、`txBytes` | 向后兼容 |
| `aya_add_port` | `existed`、`replace` | 向后兼容 |
| `aya_remove_port` | `direction` 必填或自动推断并回显 | 行为更严格 |
| `aya_cast_window` | 支持可选 `deviceId` | 向后兼容 |
| 新增 | `aya_webview_eval/wait/click/input/navigate/console`、`aya_list_displays`、`aya_set_rotation/density/resolution/locale/dark_mode/animation_scale`、`aya_stats` | 新增 |

## 7. 分阶段落地与验收

### 阶段 1（1–2 天）：正确性

- P0-1 rename 修复、P0-2 输入法、P0-6 logcat 摘要、P0-7 串口 resume、BUG-09/10/11 小修。
- 验收：重跑 B-04、B-05、C-06、C-08、A-06；A-06 输入内容必须与预期完全一致。

### 阶段 2（3–5 天）：延迟

- P0-3 快照复用、P0-4 batch resolveOnce、P0-5 默认值收敛、P1-3/P1-4。
- 验收：重跑 D-01、A-04、D-04；达到第 2 节阈值，且 `aya_batch` 输出 token 下降 ≥ 50%。

### 阶段 3（1–2 周）：H5 与采集

- P1-1 CDP 工具集、P1-2 截图瘦身、P1-5 应用管理、P1-6 适配工具。
- 验收：重跑 A-01～A-09、D-02；H5 点击/读值 ≤ 300 ms，截图 ≤ 400 KB。

### 阶段 4（长期）：架构

- P2-1 无障碍事件、P2-2 指纹缓存、P2-3 结果协议 v2、P2-4 指标。
- 验收：D-04 等元素 ≤ 300 ms；`aya_stats` 可输出各工具 p95。

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 快照复用点到旧坐标 | 误点击 | 指纹校验 + `reuseSnapshot:"strict"` + 点击后 `ui.changed` |
| 自动切换 IME 改变用户环境 | 影响其他应用 | 输入后恢复原 IME；`ime:"keep"` 可关闭 |
| CDP 要求应用可调试 | 部分应用不可用 | 检测失败自动回退 UI 树路径 |
| 默认 `withUi`/`maxNodes` 变化 | 旧提示词行为变化 | 保留显式参数；CHANGELOG 标注；灰度开关 |
| 无障碍服务常驻 | 功耗/内存 | 按需启动、空闲超时退出 |

## 9. 附：最小改动优先级（若只能做三件事）

1. **修 `file.ts` 的 `fileShell`**（1 行 + 校验）——消除假成功。
2. **`afterInput` 保留快照 + `aya_batch` 一次解析**——直接砍掉 50%–70% 的 dump。
3. **接 CDP 的 `aya_webview_eval`**——H5 场景从秒级降到百毫秒级。

## 10. 落地状态（本次改动）

| 项 | 状态 | 落点 | 验证方式 |
| --- | --- | --- | --- |
| P0-1 rename 假成功 | ✅ | `adb/file.ts` + `tools/file.ts` 回读 `ls` | `aya_rename_path` 后目标存在/源不存在 |
| P0-2 IME 预检与清空 | ✅ | `performText({clear})`、返回 `cleared/imeSwitched` | 非拉丁键盘下输入 ASCII 内容一致 |
| P0-3 快照复用 | ✅ | `ensureSnapshot(auto/snapshot/dump)`，dump 后指纹一致即复用 | `aya_batch resolve:"snapshot"` 无 dump |
| P0-4 batch 一次解析 | ✅ | `batch` 就地解析，`uiMode:none/diff/full` | `aya_stats` 中 dump 次数不随步骤数线性增长 |
| P0-5 默认值收敛 | ✅ | `maxNodes`、`uiMaxNodes`、`settle:0`、JPEG q72 | 单次点击返回体积明显下降 |
| P0-6 logcat 摘要 | ✅ | `summarizeLogcat` + `pid/since/summary` + `aya_logcat_wait` | FATAL/ANR 直接命中 |
| P0-7 串口 resume | ✅ | `aya_serial_pause/resume` | 暂停期间不再推送、恢复后继续 |
| P1-1 CDP 工具集 | ✅ | `lib/cdp.ts` + `webview.ts`（list/snapshot/eval/console/network/wait/click/input/navigate） | H5 点击/读值 100ms 级 |
| P1-2 截图瘦身 | ✅ | `format/quality/crop/saveTo/displayId` | 默认 JPEG，`saveTo` 只回路径 |
| P1-3 dump 结构化 | ✅ | `fields/cursor/reuse/diffFrom` + `expiresAt/fingerprint` | 大页面可分批读取 |
| P1-4 wait 降耗 | ✅ | 自适应间隔、`stableFor`、`withUi` | 稳定态命中耗时接近一个 TTL |
| P1-5 应用管理 | ✅ | `start_app(waitFor/timeout)`、`app_info(apkSize/signature)`、`install/uninstall` 回读 | 启动/安装失败可定位 |
| P1-6 适配工具 | ✅ | `adapt.ts`：rotation/density/resolution/locale/dark_mode/animation_scale/list_displays | 全部返回 `previous → current → applied` |
| P2-2 指纹与 LRU | ✅ | `snapshot.ts` 的 `fingerprint/history/diffSnapshot` | `aya_ui_dump diffFrom` 输出增删节点 |
| P2-4 可观测性 | ✅ | `lib/stats.ts` + `protocol.ts` 埋点 + `aya_stats` | `aya_stats` 输出 p50/p95、dump 复用率 |
| P2-1 无障碍事件 | ⬜ | 需扩展 `aya.dex`，留待后续 | — |
| P2-3 结果协议 v2 | ✅ | `lib/envelope.ts` + `protocol.ts` 统一注入 `timing/cost/retryable/snapshot/suggestedNextCall`（覆盖全部 70 个工具，无需逐工具适配） | 任意工具返回都带这 5 个字段；失败时 `suggestedNextCall` 给出下一步 |
| `aya_cast_window` deviceId | ✅ | `showWin(deviceId)` + 渲染端 `pinnedDeviceId` 固定设备 | 传 deviceId 打开窗口后切换主窗口设备，投屏目标不变 |

> 说明：`aya_webview_run`（脚本批量执行）与 `aya_webview_watch`（事件流）暂未实现，前者可用 `aya_batch` + `aya_webview_eval` 组合替代，后者建议等 P2-1 无障碍事件方案一起做。

## 11. 第二轮真机测试（2026-10-24）暴露问题的修复

| 问题 | 现象 | 修复 | 落点 |
| --- | --- | --- | --- |
| 短 id 匹配不到 | `aya_tap {id:"btnLock"}` 恒 `NO_MATCH`，因为设备返回的是 `com.foo:id/btnLock` | 精确匹配同时认 `/` 之后的短名 | `lib/ui.ts#matchId` |
| 滚动子项坐标越界 | `tvChip bounds=[1924,458][1900,490]`（左 > 右），点击落空 | 解析时与父容器求交，新增 `visible` / `rawBounds` | `lib/snapshot.ts#intersect` |
| 只解析第一个窗口 | 状态栏、导航栏、输入法窗口的节点全部丢失 | 收集全部窗口根 `roots[]`，`flat` 合并所有节点 | `lib/snapshot.ts#parseSnapshot` |
| dump 夹带屏幕外节点 | 265 个节点里 75+ 是滚出屏幕的列表项 | 新增 `visibleOnly`，返回 `invisibleTotal` / `hidden` | `tools/screen.ts`、`lib/ui.ts#compactTree` |
| 长按能力缺失 | 只能用 `adb shell input swipe x y x y ms` 绕过 | 新增 `aya_long_press`，支持坐标或 id/text 定位 | `tools/gesture.ts` |
| 按住后拖动/多段路径无解 | `input swipe` 一次命令一次触摸，且只能走直线 | 新增 `aya_gesture`：服务端 `UiAutomation.injectInputEvent` 注入 down/move/up 事件流，按住期间可用 `captureAt` 抓树；异常时补 `ACTION_CANCEL` 防止触摸卡住 | `Ui.kt#gesture`、`adb/server.ts#injectGesture` |
| 定位失败无诊断 | 只回 `NO_MATCH`，瞬态消失与 id 写错无法区分 | 返回 `nearMatches` / `invisibleTotal` / `snapshotAgeMs`，`suggestedNextCall` 直接给出相近控件 | `lib/target.ts#diagnoseMiss`、`lib/envelope.ts` |
| wait 把不可见当存在 | 等加载遮罩消失时误判 | 默认忽略不可见节点，`includeInvisible:true` 可放宽 | `tools/wait.ts` |
| nodeIndex 点到不可见节点 | 静默点空，无任何提示 | 返回 `warning` 提示先滚动到可见区域 | `lib/target.ts` |

验收：`parseSnapshot` 逻辑校验 9 项全过（多窗口合并、越界裁剪、部分可见裁剪、短 id 匹配、`visibleOnly` 过滤、`compactTree` 丢弃不可见）；`tsc --noEmit` 与 `eslint` 在 MCP 目录无新增问题；`gradlew :server:assembleRelease` 构建通过，`resources/aya.dex` 已同步。
