// Дописывает в ios/App/App/Info.plist то, что Capacitor не добавляет сам.
// Запускается автоматически в `npm run ios:sync`. Повторный запуск ничего не ломает.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plist = join(root, "ios", "App", "App", "Info.plist");
if (!existsSync(plist)) { console.error("Нет", plist, "— сначала выполните: npx cap add ios"); process.exit(1); }

const KEYS = {
  // Без этой строки iOS не разрешит Face ID (приложение упадёт при первом запросе).
  NSFaceIDUsageDescription: "<string>Face ID открывает сейф без ввода мастер-пароля.</string>",
  // Светлый текст статус-бара на тёмном фоне.
  UIStatusBarStyle: "<string>UIStatusBarStyleLightContent</string>",
  // Ссылки shut://tasks|calendar|notes открывают приложение (их использует виджет на главном экране).
  CFBundleURLTypes: "<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>app.shut.wallet</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>shut</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>",
};

let xml = await readFile(plist, "utf8");
let added = [];
for (const [k, v] of Object.entries(KEYS)) {
  if (xml.includes(`<key>${k}</key>`)) continue;
  const end = xml.lastIndexOf("</dict>");
  xml = xml.slice(0, end) + `\t<key>${k}</key>\n\t${v}\n` + xml.slice(end);
  added.push(k);
}
await writeFile(plist, xml);
console.log(added.length ? "Info.plist: добавлено " + added.join(", ") : "Info.plist: уже настроен");
