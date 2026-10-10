import assert from 'node:assert';
import { createUpdater } from '../lib/updater.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

console.log('updater.test.js');

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '3dosero-test-'));

try {
  let checkCount = 0;
  const updater = createUpdater({
    repo: 'HARUSINN0422/3Dosero',
    branch: 'main',
    appRoot: '.',
    dataDir: tmpDir,
    enabled: false,
  });

  updater.check = async () => {
    checkCount++;
    return updater.status;
  };

  const stop = updater.startPeriodic({ firstDelayMs: 20, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  stop();

  const countAfterStop = checkCount;
  assert.ok(countAfterStop >= 2, `定期チェックが実行されること (count: ${countAfterStop})`);

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(checkCount, countAfterStop, '停止後は定期チェックが実行されないこと');
  console.log('  ✓ 定期更新タイマーの動作と停止');

  console.log('\nすべてのアップデータテスト成功');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
