package app.kayospace.securestore

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class KeyArgs {
    var key: String = ""
}

@InvokeArg
class SetArgs {
    var key: String = ""
    var value: String = ""
}

/**
 * Секреты Kayospace (токен хаба) на Android.
 *
 * Ключ AES-256 живёт в Android Keystore и не покидает его; в SharedPreferences лежит только
 * зашифрованное значение (AES-GCM) вместе с IV. Если ключ пропал (например, приложение
 * восстановили из резервной копии на другом телефоне), значение считается отсутствующим.
 */
@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs by lazy { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    @Command
    fun get(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        if (!validKey(args.key)) return invoke.reject("недопустимое имя секрета")
        val ret = JSObject()
        val stored = prefs.getString(args.key, null)
        if (stored != null) {
            try {
                ret.put("value", decrypt(stored))
            } catch (e: Exception) {
                Log.w("kayospace", "secure-store: не расшифровать «${args.key}», забываю его", e)
                prefs.edit().remove(args.key).apply()
            }
        }
        invoke.resolve(ret)
    }

    @Command
    fun set(invoke: Invoke) {
        val args = invoke.parseArgs(SetArgs::class.java)
        if (!validKey(args.key)) return invoke.reject("недопустимое имя секрета")
        try {
            prefs.edit().putString(args.key, encrypt(args.value)).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("хранилище Android: ${e.message}")
        }
    }

    @Command
    fun remove(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        if (!validKey(args.key)) return invoke.reject("недопустимое имя секрета")
        prefs.edit().remove(args.key).apply()
        invoke.resolve()
    }

    private fun validKey(key: String): Boolean =
        key.isNotEmpty() && key.length <= 64 && key.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val data = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return b64(cipher.iv) + ":" + b64(data)
    }

    private fun decrypt(stored: String): String {
        val parts = stored.split(":")
        require(parts.size == 2) { "повреждённая запись" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, unb64(parts[0])))
        return String(cipher.doFinal(unb64(parts[1])), Charsets.UTF_8)
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "kayospace.secure-store"
        const val PREFS = "kayospace.secure-store"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
