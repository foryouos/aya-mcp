package io.liriliri.aya

import android.annotation.TargetApi
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.content.res.Configuration
import android.content.res.Resources
import android.net.LocalSocket
import android.os.Build
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class Connection(private val client: LocalSocket) : Thread() {
    private companion object {
        private const val TAG = "Aya.Connection"
        private var packageCache = JSONObject()
        private const val ICON_CACHE_DIR = "/data/local/tmp/aya/icons"
        // label/icon 的内存缓存原来只活在进程内，设备重启后要重新解析全部 APK 资源表，
        // 首次加载会超过主机超时。这里把缓存落到磁盘，重启后直接命中。
        private const val CACHE_INDEX_FILE = "$ICON_CACHE_DIR/index.json"
        private const val MAX_PARALLEL = 4

        init {
            val iconCacheDir = File(ICON_CACHE_DIR)
            if (!iconCacheDir.exists()) {
                iconCacheDir.mkdirs()
            }
            loadCacheIndex()
        }

        @Synchronized
        private fun loadCacheIndex() {
            try {
                val file = File(CACHE_INDEX_FILE)
                if (file.exists()) {
                    packageCache = JSONObject(file.readText())
                    Log.i(TAG, "Loaded ${packageCache.length()} cached package infos")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load cache index", e)
            }
        }

        @Synchronized
        private fun saveCacheIndex() {
            try {
                val tmp = File("$CACHE_INDEX_FILE.tmp")
                tmp.writeText(packageCache.toString())
                val target = File(CACHE_INDEX_FILE)
                if (target.exists()) {
                    target.delete()
                }
                tmp.renameTo(target)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save cache index", e)
            }
        }

        @Synchronized
        private fun cacheGet(key: String): JSONObject? {
            return if (packageCache.has(key)) packageCache.getJSONObject(key) else null
        }

        @Synchronized
        private fun cachePut(key: String, label: String, icon: String) {
            val info = JSONObject()
            info.put("label", label)
            info.put("icon", icon)
            packageCache.put(key, info)
        }
    }

    override fun run() {
        while (!isInterrupted && client.isConnected) {
            try {
                val request = Wire.Request.parseDelimitedFrom(client.inputStream)
                val params = request.params.ifEmpty { "{}" }
                handleRequest(request.id, request.method, params)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to handle request", e)
                break
            }
        }

        client.close()
        Log.i(TAG, "Client disconnected")
    }

    private fun handleRequest(id: String, method: String, params: String) {
        Log.i(TAG, "Request method: $method, params: $params")

        val result = JSONObject()

        when (method) {
            "getVersion" -> {
                result.put("version", getVersion())
            }

            "getPackageInfos" -> {
                result.put("packageInfos", getPackageInfos(JSONObject(params)))
            }

            "startFileServer" -> {
                val port = HttpFileServerManager.start()
                result.put("port", port)
            }

            "isFileServerRunning" -> {
                val running = HttpFileServerManager.isRunning()
                result.put("running", running)
            }

            "ui.dump" -> {
                val options = JSONObject(params)
                try {
                    result.put(
                        "xml",
                        Ui.dumpXml(options.optInt("maxNodes", 1500), options.optInt("maxDepth", 60))
                    )
                } catch (e: Throwable) {
                    // 通道不可用不切断连接，交由主进程降级到 uiautomator dump
                    Log.e(TAG, "ui.dump failed", e)
                    result.put("xml", "")
                    result.put("error", e.toString())
                }
            }

            "ui.state" -> {
                result.put("state", Ui.state())
            }

            "ui.gesture" -> {
                try {
                    result.put("gesture", Ui.gesture(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.gesture failed", e)
                    result.put("error", e.toString())
                }
            }

            "ui.tap" -> {
                try {
                    result.put("tap", Ui.tap(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.tap failed", e)
                    result.put("error", e.toString())
                }
            }

            "ui.swipe" -> {
                try {
                    result.put("swipe", Ui.swipe(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.swipe failed", e)
                    result.put("error", e.toString())
                }
            }

            "ui.key" -> {
                try {
                    result.put("key", Ui.key(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.key failed", e)
                    result.put("error", e.toString())
                }
            }

            "ui.text" -> {
                try {
                    result.put("text", Ui.setText(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.text failed", e)
                    result.put("error", e.toString())
                }
            }

            "ui.screenshot" -> {
                try {
                    result.put("shot", Ui.screenshot(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.screenshot failed", e)
                    result.put("error", e.toString())
                }
            }

            // 阻塞调用（最长 timeoutMs）：主机端必须用独立连接发起
            "ui.watch" -> {
                try {
                    result.put("watch", Ui.watch(JSONObject(params)))
                } catch (e: Throwable) {
                    Log.e(TAG, "ui.watch failed", e)
                    result.put("error", e.toString())
                }
            }

            else -> {
                Log.e(TAG, "Unknown method: $method")
            }
        }

        Log.i(TAG, "Response: $result")
        Wire.Response.newBuilder().setId(id).setResult(result.toString()).build()
            .writeDelimitedTo(client.outputStream)
    }

    private fun getVersion(): String {
        return BuildConfig.VERSION_NAME
    }

    private fun getPackageInfos(params: JSONObject): JSONArray {
        val packageNames = Util.jsonArrayToStringArray(params.getJSONArray("packageNames"))
        val result = JSONArray()
        val size = packageNames.size
        if (size == 0) {
            return result
        }

        // 单个包要反射解析整份 APK 资源表并编码图标，
        // 串行处理 50 个包在设备刚启动时很容易超过主机超时，这里改成小并发。
        val infos = arrayOfNulls<JSONObject>(size)
        val executor = Executors.newFixedThreadPool(Math.min(MAX_PARALLEL, size))
        val latch = CountDownLatch(size)
        for (i in 0 until size) {
            val index = i
            executor.execute {
                try {
                    infos[index] = getPackageInfo(packageNames[index])
                } catch (e: Exception) {
                    Log.e(TAG, "Fail to get package info: ${packageNames[index]}", e)
                } finally {
                    latch.countDown()
                }
            }
        }

        try {
            latch.await(120, TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Log.e(TAG, "Interrupted while loading package infos", e)
        }
        executor.shutdown()

        // 整批处理完统一落盘一次，避免每包都写文件
        saveCacheIndex()

        for (info in infos) {
            if (info != null) {
                result.put(info)
            }
        }

        return result
    }

    @TargetApi(Build.VERSION_CODES.P)
    private fun getPackageInfo(packageName: String): JSONObject {
        var flags = PackageManager.GET_ACTIVITIES
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            flags = flags or PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            flags = flags or PackageManager.GET_SIGNATURES
        }
        val packageInfo =
            ServiceManager.packageManager.getPackageInfo(packageName, flags)

        val info = JSONObject()
        info.put("packageName", packageInfo.packageName)
        info.put("versionName", packageInfo.versionName)
        info.put("firstInstallTime", packageInfo.firstInstallTime)
        info.put("lastUpdateTime", packageInfo.lastUpdateTime)
        info.put("signatures", getSignatures(packageInfo))

        val applicationInfo = packageInfo.applicationInfo
        var apkSize = 0L
        val apkPath = applicationInfo.sourceDir
        apkSize = File(apkPath).length()
        info.put("apkPath", apkPath)
        info.put("apkSize", apkSize)
        info.put("enabled", applicationInfo.enabled)

        var system = false
        if ((applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM) == ApplicationInfo.FLAG_SYSTEM) {
            system = true
        }
        info.put("system", system)

        var label = packageName

        val cacheKey = "$packageName.$apkSize"
        var icon = ""

        val cached = cacheGet(cacheKey)
        if (cached != null) {
            label = cached.optString("label", packageName)
            icon = cached.optString("icon", "")
        } else {
            val resources = getResources(apkPath)
            val labelRes = applicationInfo.labelRes
            if (labelRes != 0) {
                try {
                    label = resources.getString(labelRes)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get label for $packageName")
                }
            }

            if (applicationInfo.icon != 0) {
                try {
                    icon = "$ICON_CACHE_DIR/$cacheKey.png"
                    val file = File(icon)
                    if (!file.exists()) {
                        val resIcon = resources.getDrawable(applicationInfo.icon)
                        val bitmapIcon = Util.drawableToBitmap(resIcon)
                        val pngIcon = Util.bitMapToPng(bitmapIcon, 20)
                        file.writeBytes(pngIcon)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get icon for $packageName")
                }
            }
            cachePut(cacheKey, label, icon)
        }
        info.put("label", label)
        info.put("icon", icon)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            info.put("minSdkVersion", applicationInfo.minSdkVersion)
            info.put("targetSdkVersion", applicationInfo.targetSdkVersion)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                val stats = ServiceManager.storageStatsManager.queryStatsForPackage(
                    packageName
                )
                info.put("appSize", stats.appBytes)
                info.put("dataSize", stats.dataBytes)
                info.put("cacheSize", stats.cacheBytes)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get storage stats for $packageName", e)
            }
        }

        return info
    }

    private fun getResources(apkPath: String): Resources {
        val assetManager = AssetManager::class.java.newInstance() as AssetManager
        val addAssetManagerMethod =
            assetManager.javaClass.getMethod("addAssetPath", String::class.java)
        addAssetManagerMethod.invoke(assetManager, apkPath)

        val displayMetrics = DisplayMetrics()
        displayMetrics.setToDefaults()
        val configuration = Configuration()
        configuration.setToDefaults()

        return Resources(assetManager, displayMetrics, configuration)
    }

    private fun getSignatures(packageInfo: PackageInfo): JSONArray {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.signingInfo.apkContentsSigners
        } else {
            packageInfo.signatures
        }

        val array = JSONArray()
        signatures.forEach {
            array.put(Base64.encodeToString(it.toByteArray(), Base64.NO_WRAP))
        }
        return array
    }
}
