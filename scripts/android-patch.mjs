// Дописывает в Android-проект (android/) то, что Capacitor не добавляет сам.
// Запускается автоматически в `npm run android:sync` и в сборке GitHub Actions. Повторный запуск ничего не ломает.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, "android", "app");
const manifestPath = join(app, "src", "main", "AndroidManifest.xml");
const gradlePath = join(app, "build.gradle");
if (!existsSync(manifestPath)) { console.error("Нет", manifestPath, "— сначала выполните: npx cap add android"); process.exit(1); }

/* ---------- AndroidManifest.xml ---------- */
let xml = await readFile(manifestPath, "utf8");
const PERMS = [
  // камера: сканер QR (вход на новом устройстве) и штрихкодов скидочных карт
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  // вход по отпечатку
  '<uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  // напоминания о событиях (Android 13+ спрашивает разрешение)
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
];
const added = [];
for (const p of PERMS) {
  const name = /android:name="([^"]+)"/.exec(p)[1];
  if (xml.includes(`"${name}"`)) continue;
  xml = xml.replace("</manifest>", `    ${p}\n</manifest>`);
  added.push(name.split(".").pop());
}
// Ссылки shut://tasks|calendar|notes открывают приложение (их использует виджет на главном экране)
if (!xml.includes('android:scheme="shut"')) {
  xml = xml.replace("</activity>", `    <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="shut" />
            </intent-filter>
        </activity>`);
  added.push("shut://");
}
// Виджет на главном экране
if (!xml.includes(".ShutWidget")) {
  xml = xml.replace("</application>", `    <receiver android:name=".ShutWidget" android:label="SHUT" android:exported="false">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/shut_widget_info" />
        </receiver>
    </application>`);
  added.push("widget");
}
// Не класть данные приложения в облачные резервные копии Google: ключ из Keystore на другом телефоне всё равно не откроется
if (xml.includes('android:allowBackup="true"')) { xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"'); added.push("allowBackup=false"); }
await writeFile(manifestPath, xml);

/* ---------- файлы виджета (native/android-widget → android/app/src/main) ---------- */
await cp(join(root, "native", "android-widget", "java"), join(app, "src", "main", "java"), { recursive: true });
await cp(join(root, "native", "android-widget", "res"), join(app, "src", "main", "res"), { recursive: true });

/* ---------- значок уведомлений (белый щит) ---------- */
const drawable = join(app, "src", "main", "res", "drawable");
await mkdir(drawable, { recursive: true });
await writeFile(join(drawable, "ic_stat_shut.xml"), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:pathData="M12,2L4,5v6c0,5.25 3.4,9.9 8,11 4.6,-1.1 8,-5.75 8,-11V5l-8,-3zM12,8a2,2 0,0 1,1 3.73V15h-2v-3.27A2,2 0,0 1,12 8z"/>
</vector>
`);

/* ---------- app/build.gradle: подпись релиза и номер версии ---------- */
let gradle = await readFile(gradlePath, "utf8");
if (!gradle.includes("SHUT_KEYSTORE")) {
  gradle = gradle.replace(/(\n\s*buildTypes\s*\{)/, `
    // Подпись релиза: ключ передаётся через переменные окружения (секреты GitHub), в репозитории его нет
    signingConfigs {
        release {
            if (System.getenv("SHUT_KEYSTORE")) {
                storeFile file(System.getenv("SHUT_KEYSTORE"))
                storePassword System.getenv("SHUT_KEYSTORE_PASSWORD")
                keyAlias System.getenv("SHUT_KEY_ALIAS")
                keyPassword System.getenv("SHUT_KEYSTORE_PASSWORD")
                storeType "pkcs12"
            }
        }
    }$1`);
  gradle = gradle.replace(/(buildTypes\s*\{\s*release\s*\{)/, `$1
            if (System.getenv("SHUT_KEYSTORE")) signingConfig signingConfigs.release`);
  added.push("signing");
}
// номер сборки из CI (каждая новая сборка — новая версия, телефон ставит её поверх старой)
const vc = parseInt(process.env.SHUT_VERSION_CODE || "", 10);
if (vc > 0) {
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${vc}`).replace(/versionName\s+"[^"]*"/, `versionName "1.0.${vc}"`);
  added.push("versionCode " + vc);
}
await writeFile(gradlePath, gradle);

console.log(added.length ? "Android: " + added.join(", ") : "Android: уже настроен");
