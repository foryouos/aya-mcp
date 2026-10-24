package io.liriliri.aya

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONObject
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
        enableViewIds(cls, instance)
        Log.i(TAG, "UiAutomation connected")

        return instance
    }

    // 不开这个 flag 时 resource-id 恒为 null，id/text 定位会全部失效
    private fun enableViewIds(cls: Class<*>, instance: Any) {
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
            setInfo.invoke(instance, info)
        } catch (e: Throwable) {
            Log.w(TAG, "fail to enable view ids", e)
        }
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
