// 版本号 / 版本戳同步：package.json 是唯一手改处（version + buildStamp），
// 游戏内显示、安卓 build.gradle、PC tauri.conf.json / Cargo.toml 都由这里生成。
// 用法：构建脚本自动调用；也可单独跑 `node tools/sync-version.mjs`
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function syncVersion({ dev = false } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const stamp = pkg.buildStamp || '';

  // 游戏内设置页版本号显示（打包时随 src 一起拷进 mobile/web）
  const info = `// 由 tools/sync-version.mjs 生成，勿手改：改 package.json 的 version / buildStamp\n`
    + `export const APP_VERSION = '${version}';\nexport const BUILD_STAMP = '${stamp}';\n`
    + `// DEV = 开发运行（npm run dev）：游戏完全不联网，免得把开发中的版本号发到服务器。\n`
    + `// 任何发布构建（build:pc / android:build / build）都会把它清回 false。\n`
    + `export const DEV = ${dev ? 'true' : 'false'};\n`;
  const infoPath = join(root, 'src', 'build-info.js');
  if (await readFile(infoPath, 'utf8').catch(() => '') !== info) await writeFile(infoPath, info);

  // PC 安装包版本
  const confPath = join(root, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(await readFile(confPath, 'utf8'));
  if (conf.version !== version) {
    conf.version = version;
    await writeFile(confPath, JSON.stringify(conf, null, 2) + '\n');
  }
  // Cargo 的 [package] version 在第 3 行（首处匹配即它）
  const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
  const cargo = await readFile(cargoPath, 'utf8');
  const cargoNext = cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (cargoNext !== cargo) await writeFile(cargoPath, cargoNext);

  return { version, stamp };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '')) {
  const dev = process.argv.includes('--dev');
  const { version, stamp } = await syncVersion({ dev });
  console.log(`[sync-version] 版本 ${version}${stamp ? ` · ${stamp}` : ''}${dev ? '（开发运行 · 已关闭联网）' : ''} 已同步到 src/build-info.js、tauri.conf.json、Cargo.toml`);
}
