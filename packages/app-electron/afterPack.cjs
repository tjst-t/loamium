// electron-builder afterPack フック (ローカル Windows ビルド専用)。
//
// この VM には Wine が無く、electron-builder の rcedit (exe へのアイコン/バージョン
// 埋め込み) は動かないため `signAndEditExecutable=false` でスキップしている。その代替
// として、パッキング後・zip 化前のこのフックで **pure JS の resedit** を使い、
// Loamium.exe に resources/icon.ico (芽生えアイコン B) とバージョン情報を埋め込む。
// これでエクスプローラー上の exe ファイルアイコンも Loamium になる。
//
// 注: CI (Windows ランナー) では既定の rcedit がネイティブに動くため、このフックは
// ローカルビルド時に CLI (`-c.afterPack=./afterPack.cjs`) で明示指定した場合のみ走る。
const path = require('node:path');
const fs = require('node:fs');
const ResEdit = require('resedit');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, 'Loamium.exe');
  const icoPath = path.join(__dirname, 'resources', 'icon.ico');

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  // アイコングループ ID 1 / lang 1033 を差し替え (electron.exe の既定メインアイコン)
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((item) => item.data),
  );

  // バージョン/製品情報 (signAndEditExecutable=false で欠落する分を補う)
  try {
    const vi = ResEdit.Resource.VersionInfo.createEmpty();
    vi.setFileVersion(0, 2, 0, 0);
    vi.setProductVersion(0, 2, 0, 0);
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: 'Loamium',
        FileDescription: 'Loamium',
        CompanyName: 'Loamium',
        OriginalFilename: 'Loamium.exe',
        FileVersion: '0.2.0',
        ProductVersion: '0.2.0',
      },
    );
    vi.outputToResourceEntries(res.entries);
  } catch (e) {
    console.log('[afterPack] version info をスキップ:', e && e.message);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('[afterPack] Loamium アイコン/バージョンを埋め込みました:', exePath);
};
