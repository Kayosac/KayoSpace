package app.kayospace.share

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * «Поделиться» → Kayospace. Активность приложения получает ACTION_SEND / ACTION_SEND_MULTIPLE:
 * при запуске — в activity.intent, в уже открытое приложение — через onNewIntent.
 * Присланное ждёт, пока JS заберёт его командой take (приложение спрашивает при запуске
 * и каждый раз, когда возвращается на экран).
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
    @Volatile private var pending: Intent? = null

    override fun load(webView: WebView) {
        super.load(webView)
        remember(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        remember(intent)
    }

    private fun remember(intent: Intent?) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            pending = Intent(intent)
            // Иначе тот же интент отдали бы ещё раз после поворота экрана.
            intent.action = Intent.ACTION_MAIN
        }
    }

    @Command
    fun take(invoke: Invoke) {
        val intent = pending
        pending = null
        if (intent == null) {
            invoke.resolve(JSObject().apply { put("files", JSArray()) })
            return
        }
        // Файлы читаем не на главном потоке: картинка может быть большой.
        Thread {
            try {
                invoke.resolve(read(intent))
            } catch (e: Exception) {
                Log.w("kayospace", "share-target: не прочитать присланное", e)
                invoke.reject("не прочитать присланное: ${e.message}")
            }
        }.start()
    }

    private fun read(intent: Intent): JSObject {
        val out = JSObject()
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { out.put("text", it) }
        intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { out.put("subject", it) }
        val files = JSArray()
        for (uri in streams(intent).take(MAX_FILES)) {
            val mime = activity.contentResolver.getType(uri) ?: intent.type ?: continue
            if (!mime.startsWith("image/") && mime != "application/pdf") continue
            val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
                val buf = input.readBytes()
                if (buf.size > MAX_BYTES) null else buf
            } ?: continue
            files.put(
                JSObject().apply {
                    put("name", displayName(uri) ?: "image")
                    put("mime", mime)
                    put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                },
            )
        }
        out.put("files", files)
        return out
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent): List<Uri> =
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
            } else {
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
            }
        } else {
            val one =
                if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                }
            listOfNotNull(one)
        }

    private fun displayName(uri: Uri): String? =
        try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }

    private companion object {
        const val MAX_FILES = 20
        const val MAX_BYTES = 25 * 1024 * 1024
    }
}
