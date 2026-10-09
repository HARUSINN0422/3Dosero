// GitHub から手動で更新を適用する CLI
// 使い方: npm run update
// （適用後はサーバーを再起動してください）

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater } from './updater.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const repo = process.env.UPDATE_REPO || 'HARUSINN0422/3Dosero';
const branch = process.env.UPDATE_BRANCH || 'main';

const updater = createUpdater({
  repo,
  branch,
  appRoot: ROOT,
  dataDir: path.join(ROOT, 'data'),
  enabled: true,
});

try {
  await updater.ensureBaseline();
  const status = await updater.check();
  if (status.lastError) {
    console.error('チェックに失敗しました:', status.lastError);
    process.exit(1);
  }
  if (!status.updateAvailable) {
    console.log(`最新です (${(status.remoteSha || '').slice(0, 7)})。更新の必要はありません。`);
    process.exit(0);
  }
  console.log(`更新があります: ${(status.localSha || '?').slice(0, 7)} → ${status.remoteSha.slice(0, 7)}`);
  const result = await updater.apply();
  if (result.applied) {
    console.log('更新を適用しました。サーバーを再起動してください（npm start）。');
  } else {
    console.log('適用されませんでした:', result.reason);
  }
} catch (err) {
  console.error('更新に失敗しました:', String(err?.message || err));
  process.exit(1);
}
