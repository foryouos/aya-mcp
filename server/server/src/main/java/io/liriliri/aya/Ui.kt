package io.liriliri.aya

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.reflect.Proxy
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 常驻 UiAutomation 通道。
 *
 * `uiautomator dump` 每次都要新起一个进程并重新 connect 无障碍服务（实测 2.5–5.3s），
 * 而 UiAutomation 本身可以长连：单次取树只需一次 binder 往返。这里复用 shell 身份
 * （aya.dex 由 app_process 以 shell 运行）直接构造 UiAutomation，产出与 uiautomator
 * 同构的 XML，解析侧无需改动。
 *
 * 任何一步失败都只记录 lastError 并返回 null，由主进程降级回 `uiautomator dump`。
 */
object Ui {
    private const val TAG = "Aya.Ui"
    // UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES（0x2 是 FLAG_DONT_USE_ACCESSIBILITY）
    private const val FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 0x1
    private const val FLAG_REPORT_VIEW_IDS = 0x10
    // 不加这两个时，launcher 等声明 importantForAccessibility=no 的容器会被裁掉子节点
    private const val FLAG_INCLUDE_NOT_IMPORTANT_VIEWS = 0x2
    private const val FLAG_RETRIEVE_INTERACTIVE_WINDOWS = 0x40
    private const val CONNECT_TIMEOUT_MS = 8000L
    private const val DUMP_TIMEOUT_MS = 15000L

    private val lock = Any()
    private var automation: Any? = null
    private var lastError = ""

    @Volatile
    private var mainLoopStarted = false

    fun state(): JSONObject {
        val ret = JSONObject()
        ret.put("available", automation != null)
        ret.put("error", lastError)
        ret.put("mainLoop", mainLoopStarted)
        ret.put("events", eventsInstalled)
        return ret
    }

    /**
     * UiAutomation 的同步查询依赖主 Looper 派发结果消息，必须在任何调用之前启动。
     * prepare 与 loop 必须在同一个线程里完成。
     */
    fun startMainLooper() {
        if (mainLoopStarted) {
            return
        }
        mainLoopStarted = true

        val ready = CountDownLatch(1)
        Thread({
            try {
                Looper.prepareMainLooper()
            } catch (e: Throwable) {
                Log.i(TAG, "main looper already prepared")
            }
            ready.countDown()
            try {
                Looper.loop()
            } catch (e: Throwable) {
                Log.e(TAG, "main looper exited", e)
            }
        }, "aya-main").start()

        try {
            if (!ready.await(3, TimeUnit.SECONDS)) {
                lastError = "main looper not ready"
            }
        } catch (e: Throwable) {
            lastError = "main looper not ready: $e"
        }
    }

    private fun ensure(): Any? {
        synchronized(lock) {
            automation?.let { return it }
            val looper = Looper.getMainLooper()
            if (looper == null) {
                lastError = "no main looper"
                return null
            }

            var instance: Any? = null
            var failure: Throwable? = null
            val latch = CountDownLatch(1)
            try {
                Handler(looper).post {
                    try {
                        instance = connect(looper)
                    } catch (e: Throwable) {
                        failure = e
                    } finally {
                        latch.countDown()
                    }
                }
            } catch (e: Throwable) {
                lastError = e.toString()
                Log.e(TAG, "fail to post connect", e)
                return null
            }

            if (!latch.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                lastError = "connect timeout"
                Log.e(TAG, lastError)
                return null
            }
            if (failure != null || instance == null) {
                lastError = (failure ?: IllegalStateException("null automation")).toString()
                Log.e(TAG, "UiAutomation unavailable: $lastError")
                return null
            }

            automation = instance
            lastError = ""
            return instance
        }
    }

    private fun connect(looper: Looper): Any {
        val cls = Class.forName("android.app.UiAutomation")
        val connClass = Class.forName("android.app.UiAutomationConnection")
        val connection = connClass.getDeclaredConstructor()
            .apply { isAccessible = true }
            .newInstance()

        // 第二个参数在 AOSP 里是 IUiAutomationConnection 接口（非 UiAutomationConnection 类），
        // 个别版本还会多一个 flags，这里按参数形态匹配而不是按精确签名。
        val ctor = cls.declaredConstructors.firstOrNull {
            it.parameterTypes.isNotEmpty() && it.parameterTypes[0] == Looper::class.java
        } ?: throw NoSuchMethodException("UiAutomation(Looper, ...) not found")
        ctor.isAccessible = true

        val args = mutableListOf<Any?>(looper, connection)
        if (ctor.parameterTypes.size > 2 && ctor.parameterTypes[2] == Int::class.javaPrimitiveType) {
            args.add(FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        }

        val instance = ctor.newInstance(*args.toTypedArray())
        val connect = cls.getDeclaredMethod("connect", Int::class.javaPrimitiveType)
            .apply { isAccessible = true }
        // getWindows() 只有在 connect 带 RETRIEVE_INTERACTIVE_WINDOWS 时才返回窗口列表
        connect.invoke(
            instance,
            FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES or FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        )
        configureServiceInfo(cls, instance)
        try {
            installEventListener(instance)
        } catch (e: Throwable) {
            Log.w(TAG, "fail to install accessibility listener", e)
        }
        Log.i(TAG, "UiAutomation connected")

        return instance
    }

    // 不开这些 flag 时 resource-id 恒为 null、状态栏/输入法窗口取不到；
    // eventTypes 不声明的话 onAccessibilityEvent 永远不回调
    private fun configureServiceInfo(cls: Class<*>, instance: Any) {
        try {
            val getInfo = cls.declaredMethods.firstOrNull {
                it.name == "getServiceInfo" && it.parameterTypes.isEmpty()
            }?.apply { isAccessible = true } ?: return
            val setInfo = cls.declaredMethods.firstOrNull {
                it.name == "setServiceInfo" && it.parameterTypes.size == 1
            }?.apply { isAccessible = true } ?: return

            val info = getInfo.invoke(instance) ?: return
            val flagsField = info.javaClass.getField("flags")
            val flags = flagsField.getInt(info)
            flagsField.setInt(
                info,
                flags or FLAG_REPORT_VIEW_IDS or
                    FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                    FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            )

            try {
                val eventTypesField = info.javaClass.getField("eventTypes")
                eventTypesField.setInt(
                    info,
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                        AccessibilityEvent.TYPE_WINDOWS_CHANGED or
                        AccessibilityEvent.TYPE_VIEW_SCROLLED
                )
            } catch (e: Throwable) {
                Log.w(TAG, "fail to set event types", e)
            }

            // 关闭反馈音/震动：注入大量事件时不希望设备一直响
            try {
                info.javaClass.getField("feedbackType").setInt(info, 0)
            } catch (e: Throwable) {
                // 部分 ROM 没有这个字段，忽略
            }

            setInfo.invoke(instance, info)
        } catch (e: Throwable) {
            Log.w(TAG, "fail to configure service info", e)
        }
    }

    /**
     * 按步骤注入触摸事件：down → (delay) → move ... → up。
     *
     * 整段事件流只有一次 ACTION_DOWN，所以能表达「按住不动一段时间再拖动」「多段路径」，
     * 这是 `input swipe`（一次命令一次触摸、匀速直线插值）做不到的。
     * 步骤间的 delayMs 用调用线程 sleep，主 looper 保持空闲，因此按住期间还能插入一次
     * dump（captureAt），拿到「按住中」的界面树。
     */
    fun gesture(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val steps = params.optJSONArray("steps")
            ?: throw IllegalArgumentException("steps required")
        if (steps.length() == 0) {
            throw IllegalArgumentException("steps is empty")
        }

        val captureAt = params.optInt("captureAt", -1)
        val maxNodes = params.optInt("maxNodes", 1500)
        val maxDepth = params.optInt("maxDepth", 60)
        val ret = JSONObject()
        val started = SystemClock.uptimeMillis()
        var downTime = started
        var lastX = 0f
        var lastY = 0f

        try {
            for (i in 0 until steps.length()) {
                val step = steps.optJSONObject(i) ?: continue
                val action = step.optString("action", "move").lowercase()
                val x = step.optDouble("x", lastX.toDouble()).toFloat()
                val y = step.optDouble("y", lastY.toDouble()).toFloat()
                val delay = step.optLong("delayMs", 0L)
                if (delay > 0) {
                    Thread.sleep(delay)
                }

                val now = SystemClock.uptimeMillis()
                val motionAction = when (action) {
                    "down" -> {
                        downTime = now
                        MotionEvent.ACTION_DOWN
                    }
                    "up" -> MotionEvent.ACTION_UP
                    "cancel" -> MotionEvent.ACTION_CANCEL
                    else -> MotionEvent.ACTION_MOVE
                }
                inject(instance, motionAction, downTime, now, x, y)
                lastX = x
                lastY = y

                if (i == captureAt) {
                    ret.put("xml", dumpXml(maxNodes, maxDepth))
                }
            }
        } catch (e: Throwable) {
            // 事件流中途出错时必须补一个 CANCEL：否则系统会一直认为手指按在屏幕上，
            // 后续所有点击都会失效
            runCatching {
                inject(
                    instance,
                    MotionEvent.ACTION_CANCEL,
                    downTime,
                    SystemClock.uptimeMillis(),
                    lastX,
                    lastY
                )
            }
            throw e
        }

        ret.put("ok", true)
        ret.put("totalMs", SystemClock.uptimeMillis() - started)
        return ret
    }

    private fun inject(
        instance: Any,
        action: Int,
        downTime: Long,
        eventTime: Long,
        x: Float,
        y: Float
    ) {
        val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
        try {
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            val method = instance.javaClass.getMethod(
                "injectInputEvent",
                android.view.InputEvent::class.java,
                Boolean::class.javaPrimitiveType
            )
            // sync 传 false：不等应用消费完，避免个别 ROM 上阻塞到超时
            method.invoke(instance, event, false)
        } finally {
            event.recycle()
        }
    }

    // ---------------- 基础注入（替代 adb shell input） ----------------

    /**
     * 单击：一次 down + up 事件。相比 `input tap` 省掉一个进程的启动与 adb 往返，
     * 实测从 200-400ms 降到几十毫秒。
     */
    fun tap(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val x = params.optDouble("x", Double.NaN).toFloat()
        val y = params.optDouble("y", Double.NaN).toFloat()
        if (x.isNaN() || y.isNaN()) {
            throw IllegalArgumentException("x and y required")
        }

        val started = SystemClock.uptimeMillis()
        inject(instance, MotionEvent.ACTION_DOWN, started, started, x, y)
        inject(instance, MotionEvent.ACTION_UP, started, started + 20, x, y)

        return JSONObject()
            .put("ok", true)
            .put("totalMs", SystemClock.uptimeMillis() - started)
    }

    /**
     * 滑动：按 ~16ms 一帧插值 move 事件，节奏对齐 `input swipe` 的匀速直线。
     * 与 gesture 的区别是这里只做一条直线，参数与 aya_swipe 一一对应。
     */
    fun swipe(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val x1 = params.optDouble("x1", Double.NaN).toFloat()
        val y1 = params.optDouble("y1", Double.NaN).toFloat()
        val x2 = params.optDouble("x2", Double.NaN).toFloat()
        val y2 = params.optDouble("y2", Double.NaN).toFloat()
        if (x1.isNaN() || y1.isNaN() || x2.isNaN() || y2.isNaN()) {
            throw IllegalArgumentException("x1/y1/x2/y2 required")
        }
        val duration = params.optLong("durationMs", 300L).coerceIn(20L, 20000L)
        val steps = Math.max(4, Math.min(60, (duration / 16).toInt()))
        val started = SystemClock.uptimeMillis()

        try {
            inject(instance, MotionEvent.ACTION_DOWN, started, started, x1, y1)
            for (i in 1 until steps) {
                val t = i.toFloat() / steps
                val target = started + (duration * t).toLong()
                val wait = target - SystemClock.uptimeMillis()
                if (wait > 0) {
                    Thread.sleep(wait)
                }
                inject(
                    instance,
                    MotionEvent.ACTION_MOVE,
                    started,
                    SystemClock.uptimeMillis(),
                    x1 + (x2 - x1) * t,
                    y1 + (y2 - y1) * t
                )
            }
            val tail = started + duration - SystemClock.uptimeMillis()
            if (tail > 0) {
                Thread.sleep(tail)
            }
            inject(instance, MotionEvent.ACTION_UP, started, SystemClock.uptimeMillis(), x2, y2)
        } catch (e: Throwable) {
            // 中途失败必须补 CANCEL，否则系统认为手指还按在屏幕上
            runCatching {
                inject(
                    instance,
                    MotionEvent.ACTION_CANCEL,
                    started,
                    SystemClock.uptimeMillis(),
                    x2,
                    y2
                )
            }
            throw e
        }

        return JSONObject()
            .put("ok", true)
            .put("totalMs", SystemClock.uptimeMillis() - started)
            .put("steps", steps)
    }

    /** 按键：注入 KeyEvent，避免 `input keyevent` 的进程启动开销。 */
    fun key(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val keyCode = params.optInt("keycode", -1)
        if (keyCode <= 0) {
            throw IllegalArgumentException("keycode required")
        }

        val started = SystemClock.uptimeMillis()
        injectKey(instance, KeyEvent.ACTION_DOWN, started, started, keyCode)
        injectKey(instance, KeyEvent.ACTION_UP, started, started + 20, keyCode)

        return JSONObject()
            .put("ok", true)
            .put("keycode", keyCode)
            .put("totalMs", SystemClock.uptimeMillis() - started)
    }

    /**
     * 直接在焦点输入框上执行 ACTION_SET_TEXT：
     * 一次 binder 完成替换，不经过 IME，因此中文/emoji 也能原样写入。
     * 自定义控件若只监听 KeyEvent 而不响应 ACTION_SET_TEXT，performAction 会返回 false，
     * 由主进程降级到 `input text`。
     */
    fun setText(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val text = params.optString("text", "")
        val append = params.optBoolean("append", false)
        val started = SystemClock.uptimeMillis()
        val latch = CountDownLatch(1)
        var result = false
        var previous = ""
        var target = text
        var failure: Throwable? = null

        Handler(Looper.getMainLooper()).post {
            try {
                val node = findFocusedEditable(instance)
                if (node == null) {
                    throw IllegalStateException("no focused editable node")
                }
                previous = node.text?.toString() ?: ""
                // ACTION_SET_TEXT 是整体替换：clear:false 时在主机端语义上等价于「追加」
                target = if (append) previous + text else text

                val args = Bundle()
                args.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    target
                )
                result = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                if (!result) {
                    throw IllegalStateException("ACTION_SET_TEXT not supported by focused node")
                }
            } catch (e: Throwable) {
                failure = e
            } finally {
                latch.countDown()
            }
        }

        if (!latch.await(5000, TimeUnit.MILLISECONDS)) {
            throw IllegalStateException("setText timeout")
        }
        failure?.let { throw it }

        return JSONObject()
            .put("ok", true)
            .put("applied", result)
            .put("previousText", previous)
            .put("length", target.length)
            .put("append", append)
            .put("totalMs", SystemClock.uptimeMillis() - started)
    }

    /**
     * 设备端截图：UiAutomation.takeScreenshot + 缩放 + JPEG 压缩。
     * PNG 走 adb 传输时 1080p 就有 1.5MB，这里在设备上压成 JPEG 再回传，
     * 带宽通常只有原来的 1/5 - 1/10。
     */
    fun screenshot(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val maxWidth = params.optInt("maxWidth", 900)
        val quality = params.optInt("quality", 72).coerceIn(1, 100)
        val asPng = params.optString("format", "jpeg").lowercase() == "png"
        val started = SystemClock.uptimeMillis()

        val bitmap = captureBitmap(instance)
            ?: throw IllegalStateException("takeScreenshot unavailable")
        val scaled = scaleBitmap(bitmap, maxWidth)
        val out = ByteArrayOutputStream(256 * 1024)
        scaled.compress(
            if (asPng) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
            quality,
            out
        )
        val bytes = out.toByteArray()

        return JSONObject()
            .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("format", if (asPng) "png" else "jpeg")
            .put("quality", if (asPng) JSONObject.NULL else quality)
            .put("width", scaled.width)
            .put("height", scaled.height)
            .put("sourceWidth", bitmap.width)
            .put("sourceHeight", bitmap.height)
            .put("bytes", bytes.size)
            .put("totalMs", SystemClock.uptimeMillis() - started)
    }

    private fun injectKey(
        instance: Any,
        action: Int,
        downTime: Long,
        eventTime: Long,
        keyCode: Int
    ) {
        // 直接 new：KeyEvent.obtain 在部分 SDK 上不可见，且这里不走事件池
        val event = KeyEvent(downTime, eventTime, action, keyCode, 0)
        val method = instance.javaClass.getMethod(
            "injectInputEvent",
            android.view.InputEvent::class.java,
            Boolean::class.javaPrimitiveType
        )
        method.invoke(instance, event, false)
    }

    private fun findFocusedEditable(instance: Any): AccessibilityNodeInfo? {
        collectRoots(instance).forEach { root ->
            try {
                val focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                if (focus != null && focus.isEditable) {
                    return focus
                }
            } catch (e: Throwable) {
                Log.d(TAG, "findFocus failed: $e")
            }
        }

        // 兜底：有些 ROM 的 findFocus 返回 null，直接在树里找 focused + editable
        collectRoots(instance).forEach { root ->
            findEditableInTree(root, 0, 60)?.let { return it }
        }

        return null
    }

    private fun findEditableInTree(
        node: AccessibilityNodeInfo,
        depth: Int,
        maxDepth: Int
    ): AccessibilityNodeInfo? {
        if (depth > maxDepth) {
            return null
        }
        try {
            if (node.isEditable) {
                return node
            }
        } catch (e: Throwable) {
            // 节点已失效
        }
        val count = try {
            node.childCount
        } catch (e: Throwable) {
            0
        }
        for (i in 0 until count) {
            val child = try {
                node.getChild(i)
            } catch (e: Throwable) {
                null
            } ?: continue
            findEditableInTree(child, depth + 1, maxDepth)?.let { return it }
        }

        return null
    }

    private fun captureBitmap(instance: Any): Bitmap? {
        val raw = instance.javaClass.getMethod("takeScreenshot").invoke(instance) ?: return null
        if (raw is Bitmap) {
            return raw
        }

        // API 30+ 返回 UiAutomation.Screenshot：取 HardwareBuffer 再包成 Bitmap。
        // HardwareBuffer / ColorSpace 用反射拿，避免低版本设备类解析失败。
        return runCatching {
            val buffer = raw.javaClass.getMethod("getHardwareBuffer").invoke(raw) ?: return@runCatching null
            val colorSpace = runCatching {
                raw.javaClass.getMethod("getColorSpace").invoke(raw)
            }.getOrNull()
            val wrap = Bitmap::class.java.getMethod(
                "wrapHardwareBuffer",
                Class.forName("android.hardware.HardwareBuffer"),
                Class.forName("android.graphics.ColorSpace")
            )
            val wrapped = wrap.invoke(null, buffer, colorSpace) as? Bitmap ?: return@runCatching null
            wrapped.copy(Bitmap.Config.ARGB_8888, false)
        }.getOrElse {
            Log.w(TAG, "takeScreenshot result unsupported", it)
            null
        }
    }

    private fun scaleBitmap(bitmap: Bitmap, maxWidth: Int): Bitmap {
        if (maxWidth <= 0 || bitmap.width <= maxWidth) {
            return bitmap
        }
        val height = Math.max(1, (bitmap.height.toLong() * maxWidth / bitmap.width).toInt())

        return Bitmap.createScaledBitmap(bitmap, maxWidth, height, true)
    }

    fun dumpXml(maxNodes: Int, maxDepth: Int): String {
        val instance = ensure() ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        val out = StringBuilder(64 * 1024)
        val latch = CountDownLatch(1)
        var error: Throwable? = null

        Handler(Looper.getMainLooper()).post {
            try {
                val roots = collectRoots(instance)
                if (roots.isEmpty()) {
                    error = IllegalStateException("no active window")
                } else {
                    out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>")
                    out.append("\n<hierarchy rotation=\"0\">")
                    val budget = intArrayOf(maxNodes)
                    roots.forEach { appendNode(it, 1, maxDepth, budget, out) }
                    out.append("\n</hierarchy>")
                }
            } catch (e: Throwable) {
                error = e
            } finally {
                latch.countDown()
            }
        }

        if (!latch.await(DUMP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw IllegalStateException("dump timeout")
        }
        error?.let { throw it }

        return out.toString()
    }

    /**
     * 取所有交互窗口的根（状态栏、导航栏、输入法各自是独立窗口），
     * 再合并活动窗口，保证主界面不会因窗口列表缺项而丢失。
     */
    private fun collectRoots(instance: Any): List<AccessibilityNodeInfo> {
        val ret = mutableListOf<AccessibilityNodeInfo>()
        val seen = mutableSetOf<Int>()

        fun add(node: AccessibilityNodeInfo?) {
            if (node == null) {
                return
            }
            val windowId = try {
                node.windowId
            } catch (e: Throwable) {
                -1
            }
            if (windowId != -1 && !seen.add(windowId)) {
                return
            }
            ret.add(node)
        }

        // 活动窗口先取，保证主界面在任何情况下都在
        try {
            val getRoot = instance.javaClass.getMethod("getRootInActiveWindow")
            add(getRoot.invoke(instance) as? AccessibilityNodeInfo)
        } catch (e: Throwable) {
            Log.w(TAG, "getRootInActiveWindow failed", e)
        }

        try {
            val getWindows = instance.javaClass.getMethod("getWindows")
            val windows = getWindows.invoke(instance) as? List<*>
            windows?.forEach { window ->
                if (window is AccessibilityWindowInfo) {
                    add(
                        try {
                            window.root
                        } catch (e: Throwable) {
                            null
                        }
                    )
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "getWindows failed", e)
        }

        ret.forEach {
            Log.i(
                TAG,
                "root pkg=${it.packageName} cls=${it.className} children=${it.childCount} wid=${it.windowId}"
            )
        }

        return ret
    }

    private fun appendNode(
        node: AccessibilityNodeInfo,
        depth: Int,
        maxDepth: Int,
        budget: IntArray,
        out: StringBuilder
    ) {
        if (budget[0] <= 0) {
            return
        }
        budget[0]--

        val bounds = Rect()
        try {
            node.getBoundsInScreen(bounds)
        } catch (e: Throwable) {
            // 节点已失效时保留空 bounds，避免整棵树失败
        }

        out.append("\n<node")
        attr(out, "index", "0")
        attr(out, "text", node.text?.toString() ?: "")
        attr(out, "resource-id", node.viewIdResourceName ?: "")
        attr(out, "class", node.className?.toString() ?: "")
        attr(out, "package", node.packageName?.toString() ?: "")
        attr(out, "content-desc", node.contentDescription?.toString() ?: "")
        attr(out, "checkable", node.isCheckable.toString())
        attr(out, "checked", node.isChecked.toString())
        attr(out, "clickable", node.isClickable.toString())
        attr(out, "enabled", node.isEnabled.toString())
        attr(out, "focusable", node.isFocusable.toString())
        attr(out, "focused", node.isFocused.toString())
        attr(out, "scrollable", node.isScrollable.toString())
        attr(out, "long-clickable", node.isLongClickable.toString())
        attr(out, "password", node.isPassword.toString())
        attr(out, "selected", node.isSelected.toString())
        attr(out, "bounds", "[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]")

        val childCount = try {
            node.childCount
        } catch (e: Throwable) {
            0
        }

        if (depth >= maxDepth || childCount <= 0) {
            out.append(" />")
            return
        }

        out.append(">")
        for (i in 0 until childCount) {
            if (budget[0] <= 0) {
                break
            }
            val child = try {
                node.getChild(i)
            } catch (e: Throwable) {
                Log.w(TAG, "getChild($i) failed on ${node.className}: $e")
                null
            }
            if (child == null) {
                Log.w(
                    TAG,
                    "null child $i/$childCount of ${node.className} wid=${node.windowId} " +
                        "connectionId=${connectionId(node)}"
                )
                continue
            }
            appendNode(child, depth + 1, maxDepth, budget, out)
        }
        out.append("\n</node>")
    }

    private fun connectionId(node: AccessibilityNodeInfo): Int {
        return try {
            val field = AccessibilityNodeInfo::class.java.getDeclaredField("mConnectionId")
            field.isAccessible = true
            field.getInt(node)
        } catch (e: Throwable) {
            -2
        }
    }

    // ---------------- 无障碍事件（P2-1） ----------------

    private val EVENT_MERGE_MS = 80L
    private val EVENT_QUEUE_LIMIT = 200

    private val eventLock = Object()
    private val eventQueue = ArrayDeque<JSONObject>()
    private val pendingEvents = HashMap<String, JSONObject>()
    private var flushScheduled = false

    @Volatile
    private var eventsInstalled = false

    @Volatile
    private var eventTotal = 0L

    private fun installEventListener(instance: Any) {
        if (eventsInstalled) {
            return
        }
        val listenerClass = Class.forName("android.app.UiAutomation\$OnAccessibilityEventListener")
        val proxy = Proxy.newProxyInstance(
            listenerClass.classLoader,
            arrayOf(listenerClass)
        ) { _, method, args ->
            if (method.name == "onAccessibilityEvent" && args != null && args.isNotEmpty()) {
                try {
                    onEvent(args[0] as AccessibilityEvent)
                } catch (e: Throwable) {
                    Log.w(TAG, "fail to handle accessibility event", e)
                }
            }
            null
        }
        instance.javaClass
            .getMethod("setOnAccessibilityEventListener", listenerClass)
            .invoke(instance, proxy)
        eventsInstalled = true
        Log.i(TAG, "accessibility listener installed")
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()

            return
        }
        val latch = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            try {
                block()
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
    }

    private fun onEvent(event: AccessibilityEvent) {
        val summary = summarize(event) ?: return
        val key = summary.optString("type") + "|" + summary.optString("pkg")

        // 同一类型同一包名在合并窗口内只留一条并累加计数：
        // 滚动/动画时 CONTENT_CHANGED 每秒可达上百次，不合并会直接打爆 socket
        synchronized(eventLock) {
            val exist = pendingEvents[key]
            if (exist != null) {
                exist.put("count", exist.optInt("count", 1) + 1)
                exist.put("at", summary.optLong("at"))
                exist.put("text", summary.optString("text"))
            } else {
                pendingEvents[key] = summary
            }
        }
        scheduleFlush()
    }

    private fun scheduleFlush() {
        if (flushScheduled) {
            return
        }
        flushScheduled = true
        Handler(Looper.getMainLooper()).postDelayed({
            flushScheduled = false
            flushEvents()
        }, EVENT_MERGE_MS)
    }

    private fun flushEvents() {
        synchronized(eventLock) {
            if (pendingEvents.isEmpty()) {
                return
            }
            pendingEvents.values.forEach {
                eventTotal++
                eventQueue.addLast(it)
            }
            pendingEvents.clear()
            while (eventQueue.size > EVENT_QUEUE_LIMIT) {
                eventQueue.pollFirst()
            }
            eventLock.notifyAll()
        }
    }

    private fun summarize(event: AccessibilityEvent): JSONObject? {
        val type = typeName(event.eventType) ?: return null
        val ret = JSONObject()
        ret.put("type", type)
        ret.put("pkg", event.packageName?.toString() ?: "")
        ret.put("cls", event.className?.toString() ?: "")
        ret.put("at", event.eventTime)
        ret.put("count", 1)

        val text = StringBuilder()
        try {
            event.text?.forEach {
                if (text.length < 60) {
                    if (text.isNotEmpty()) {
                        text.append(' ')
                    }
                    text.append(it.toString())
                }
            }
        } catch (e: Throwable) {
            // 部分事件没有 text
        }
        ret.put("text", text.toString())

        return ret
    }

    private fun typeName(type: Int): String? = when (type) {
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "state"
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> "content"
        AccessibilityEvent.TYPE_WINDOWS_CHANGED -> "windows"
        AccessibilityEvent.TYPE_VIEW_SCROLLED -> "scroll"
        else -> null
    }

    /**
     * 订阅无障碍事件直到条件命中或超时。
     *
     * 这是阻塞调用：主机端必须用独立连接发起，否则会堵住同一连接上的其它请求。
     * 命中条件在设备端判断，避免每个事件都回传一次。
     */
    fun watch(params: JSONObject): JSONObject {
        val instance = ensure()
            ?: throw IllegalStateException("UiAutomation unavailable: $lastError")
        if (!eventsInstalled) {
            runOnMain { runCatching { installEventListener(instance) } }
        }

        val timeout = params.optLong("timeoutMs", 5000L).coerceIn(100L, 30000L)
        val settleMs = params.optLong("settleMs", 0L).coerceIn(0L, 5000L)
        val pkg = params.optString("package", "")
        val textContains = params.optString("textContains", "")
        val wanted = params.optJSONArray("types")
        val maxEvents = params.optInt("maxEvents", 20).coerceIn(1, 50)
        val started = SystemClock.uptimeMillis()

        // watch 的语义是「从调用那一刻开始的新事件」，先丢掉历史积压
        synchronized(eventLock) {
            eventQueue.clear()
            pendingEvents.clear()
        }

        val collected = JSONArray()
        var matched: JSONObject? = null
        var matchedAt = 0L

        while (true) {
            val now = SystemClock.uptimeMillis()
            val limit = if (matched != null) {
                matchedAt + settleMs - now
            } else {
                started + timeout - now
            }
            if (limit <= 0) {
                break
            }

            val event = pollEvent(limit) ?: continue
            if (collected.length() < maxEvents) {
                collected.put(event)
            }
            if (matched == null && matches(event, pkg, textContains, wanted)) {
                matched = event
                matchedAt = SystemClock.uptimeMillis()
            }
        }

        return JSONObject()
            .put("ok", true)
            .put("matched", matched != null)
            .put("waitedMs", SystemClock.uptimeMillis() - started)
            .put("timeoutMs", timeout)
            .put("settleMs", settleMs)
            .put("events", collected)
            .put("matchedEvent", matched ?: JSONObject.NULL)
            .put("eventTotal", eventTotal)
    }

    private fun pollEvent(timeoutMs: Long): JSONObject? {
        synchronized(eventLock) {
            eventQueue.pollFirst()?.let { return it }
            try {
                eventLock.wait(timeoutMs)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()

                return null
            }

            return eventQueue.pollFirst()
        }
    }

    private fun matches(
        event: JSONObject,
        pkg: String,
        textContains: String,
        types: JSONArray?
    ): Boolean {
        if (pkg.isNotEmpty() && !event.optString("pkg").contains(pkg)) {
            return false
        }
        if (textContains.isNotEmpty() &&
            !event.optString("text").contains(textContains, ignoreCase = true)
        ) {
            return false
        }
        if (types != null && types.length() > 0) {
            var hit = false
            for (i in 0 until types.length()) {
                if (types.optString(i).equals(event.optString("type"), ignoreCase = true)) {
                    hit = true
                    break
                }
            }
            if (!hit) {
                return false
            }
        }

        return true
    }

    private fun attr(out: StringBuilder, name: String, value: String) {
        out.append(' ').append(name).append("=\"").append(escape(value)).append('"')
    }

    private fun escape(value: String): String {
        if (value.isEmpty()) {
            return value
        }
        val sb = StringBuilder(value.length + 8)
        value.forEach {
            when (it) {
                '&' -> sb.append("&amp;")
                '<' -> sb.append("&lt;")
                '>' -> sb.append("&gt;")
                '"' -> sb.append("&quot;")
                '\'' -> sb.append("&apos;")
                '\n' -> sb.append("&#10;")
                '\r' -> sb.append("&#13;")
                else -> sb.append(it)
            }
        }

        return sb.toString()
    }
}
