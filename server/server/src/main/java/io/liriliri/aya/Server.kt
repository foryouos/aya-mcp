package io.liriliri.aya

import android.net.LocalServerSocket
import android.util.Log
import java.util.concurrent.Executors

class Server {
    companion object {
        private const val TAG = "Aya.Server"

        @JvmStatic
        fun main(args: Array<String>) {
            try {
                Server().start(args)
            } catch (e: Exception) {
                Log.e(TAG, "Fail to start server", e)
            }
        }
    }

    // 主连接 + ui.watch 独立连接 + 临时重连，正常不会超过个位数；
    // 用有界池避免异常情况下线程无限增长
    private val executor = Executors.newFixedThreadPool(16)
    fun start(args: Array<String>) {
        Log.i(TAG, "Start server")

        // UiAutomation 的同步查询依赖主 Looper 派发结果，先起起来再接受请求
        Ui.startMainLooper()

        val server = LocalServerSocket("aya")
        Log.i(TAG, "Server started, listening on ${server.localSocketAddress}")

        while (true) {
            val conn = Connection(server.accept())
            Log.i(TAG, "Client connected")
            executor.submit(conn)
        }
    }
}
