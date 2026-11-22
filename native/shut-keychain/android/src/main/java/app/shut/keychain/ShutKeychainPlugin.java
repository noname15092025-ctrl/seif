package app.shut.keychain;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Хранит ключ сейфа (32 байта AES) на Android. Интерфейс тот же, что у iOS-версии: status / save / load / remove.
 * Ключ сейфа шифруется AES-ключом из Android Keystore, который:
 *  - работает только после подтверждения биометрией сильного класса (отпечаток / надёжное распознавание лица);
 *  - становится недействительным, если в телефон добавят новый отпечаток;
 *  - не извлекается из защищённого чипа и не попадает в резервные копии.
 * Мастер-пароль сюда не попадает никогда.
 */
@CapacitorPlugin(name = "ShutKeychain")
public class ShutKeychainPlugin extends Plugin {
    private static final String KS = "AndroidKeyStore";
    private static final String PREFS = "shut_keychain";
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private String alias(String id) { return "shut_vault_" + id; }
    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private boolean available() {
        return BiometricManager.from(getContext()).canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private SecretKey getKey(String id) throws Exception {
        KeyStore ks = KeyStore.getInstance(KS);
        ks.load(null);
        return (SecretKey) ks.getKey(alias(id), null);
    }

    private SecretKey createKey(String id) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias(id),
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) b.setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS);
        kg.init(b.build());
        return kg.generateKey();
    }

    private void deleteAll(String id) {
        try {
            KeyStore ks = KeyStore.getInstance(KS);
            ks.load(null);
            ks.deleteEntry(alias(id));
        } catch (Exception ignored) { }
        prefs().edit().remove(id).apply();
    }

    @PluginMethod
    public void status(PluginCall call) {
        boolean avail = available();
        boolean has = false;
        String id = call.getString("id", "");
        if (id != null && !id.isEmpty()) {
            try { has = prefs().contains(id) && getKey(id) != null; } catch (Exception ignored) { }
        }
        JSObject r = new JSObject();
        r.put("available", avail);
        r.put("type", avail ? "biometric" : "none");
        r.put("has", has);
        call.resolve(r);
    }

    /** Сохраняет ключ. Android попросит приложить палец: ключ Keystore без этого не шифрует. */
    @PluginMethod
    public void save(PluginCall call) {
        final String id = call.getString("id", "");
        String b64 = call.getString("key", "");
        byte[] data;
        try { data = Base64.decode(b64 == null ? "" : b64, Base64.NO_WRAP); } catch (Exception e) { call.reject("bad arguments", "args"); return; }
        if (id == null || id.isEmpty() || data.length != 32) { call.reject("bad arguments", "args"); return; }
        if (!available()) { call.reject("no biometrics or screen lock", "nopasscode"); return; }
        Cipher cipher;
        try {
            deleteAll(id);
            SecretKey key = createKey(id);
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (Exception e) { call.reject("keystore error: " + e.getMessage(), "keychain"); return; }
        final byte[] plain = data;
        prompt(call, cipher, "Включить вход по биометрии", c -> {
            byte[] ct = c.doFinal(plain);
            Arrays.fill(plain, (byte) 0);
            String stored = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            prefs().edit().putString(id, stored).apply();
            call.resolve();
        }, () -> { Arrays.fill(plain, (byte) 0); deleteAll(id); });
    }

    /** Достаёт ключ после подтверждения биометрией. */
    @PluginMethod
    public void load(PluginCall call) {
        final String id = call.getString("id", "");
        if (id == null || id.isEmpty()) { call.reject("bad arguments", "args"); return; }
        String stored = prefs().getString(id, null);
        if (stored == null || !stored.contains(":")) { call.reject("not found", "notfound"); return; }
        Cipher cipher;
        final byte[] ct;
        try {
            SecretKey key = getKey(id);
            if (key == null) { deleteAll(id); call.reject("not found", "notfound"); return; }
            String[] parts = stored.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            ct = Base64.decode(parts[1], Base64.NO_WRAP);
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            deleteAll(id); // в телефон добавили новый отпечаток
            call.reject("not found", "notfound");
            return;
        } catch (Exception e) { call.reject("keystore error: " + e.getMessage(), "keychain"); return; }
        String reason = call.getString("reason", "Открыть сейф");
        prompt(call, cipher, reason == null ? "Открыть сейф" : reason, c -> {
            byte[] raw = c.doFinal(ct);
            JSObject r = new JSObject();
            r.put("key", Base64.encodeToString(raw, Base64.NO_WRAP));
            Arrays.fill(raw, (byte) 0);
            call.resolve(r);
        }, null);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id", "");
        if (id == null || id.isEmpty()) { call.reject("bad arguments", "args"); return; }
        deleteAll(id);
        call.resolve();
    }

    private interface CipherAction { void run(Cipher c) throws Exception; }

    private void prompt(final PluginCall call, final Cipher cipher, final String title, final CipherAction onOk, final Runnable onFail) {
        final FragmentActivity act = (FragmentActivity) getActivity();
        act.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(act, ContextCompat.getMainExecutor(act), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        BiometricPrompt.CryptoObject co = result.getCryptoObject();
                        onOk.run(co != null && co.getCipher() != null ? co.getCipher() : cipher);
                    } catch (Exception e) {
                        if (onFail != null) onFail.run();
                        call.reject("crypto error: " + e.getMessage(), "keychain");
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                    if (onFail != null) onFail.run();
                    boolean cancel = code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                            || code == BiometricPrompt.ERROR_CANCELED;
                    call.reject(msg.toString(), cancel ? "cancel" : "failed");
                }
                // onAuthenticationFailed (палец не подошёл): системное окно само даёт попробовать ещё раз
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle("SHUT")
                    .setNegativeButtonText("Мастер-пароль")
                    .setAllowedAuthenticators(AUTH)
                    .build();
            bp.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }
}
