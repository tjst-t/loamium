// ⚠️ このエントリは **UI からも import される**。Node 専用 API に依存しないこと。
//    `node:path` などが要るものは vault-path.node.ts に置き、サーバーから直接 import する。
export * from './markdown/index'
export { normalizeVaultPath, VaultPathError } from './vault-path'
