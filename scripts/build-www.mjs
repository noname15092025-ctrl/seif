// Собирает веб-папку www/ для Capacitor из статических файлов сайта.
// Копирует только то, что реально нужно приложению — без .git, md-инструкций,
// кода воркеров Cloudflare и самих скриптов сборки.
import { cp, rm, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "www");

// Явный список файлов и папок приложения.
const INCLUDE = [
  "index.html",
  "s.html",
  "app.js",
  "md.js",
  "merge.js",
  "qr.js",
  "loyalty.js",
  "calendar.js",
  "datepicker.js",
  "passkey.js",
  "notes-plus.js",
  "devlink.js",
  "date-ico.svg",
  "time-ico.svg",
  "vendor",
  "style.css",
  "sw.js",
  "manifest.webmanifest",
  "argon2.js",
  "argon2-worker.js",
  "wordlist.js",
  "fonts",
  "icon.svg",
  "shield.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of INCLUDE) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.warn("пропускаю (нет файла):", name);
    continue;
  }
  await cp(src, join(out, name), { recursive: true });
}

const copied = await readdir(out);
console.log("www/ собрана, файлов:", copied.length);
console.log(copied.join("  "));
