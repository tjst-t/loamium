/**
 * SeedService を直接呼び出してサンプルを vault に投入するスクリプト。
 * make samples のシム実装として使用する (サーバー起動不要)。
 * ユーザー向けの正式手順は `loamium init-samples` を使うこと。
 */
import { seed } from '../packages/server/src/seed-service.js';

const vaultRoot = process.env.LOAMIUM_VAULT ?? './dev-vault';
try {
  const result = await seed(vaultRoot, false);
  console.log(`${result.seeded} ファイルを ${vaultRoot} に投入しました（既存 ${result.skipped} 件はスキップ）`);
} catch (err) {
  console.error(`サンプル投入エラー: ${String(err)}`);
  process.exit(1);
}
