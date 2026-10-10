// サーバー統合テスト（WebSocket で2クライアント対局）
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { legalMoves, BLACK, WHITE, countPieces, SIZE } from '../lib/game.js';

const PORT = Number(process.env.TEST_PORT || 3299);
const BASE = `http://127.0.0.1:${PORT}`;

function createClient(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const queue = [];
  const waiters = [];
  const client = {
    name,
    ws,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    /** 次に predicate を満たすメッセージを待つ */
    wait(predicate, timeout = 5000) {
      const queuedIdx = queue.findIndex(predicate);
      if (queuedIdx >= 0) return Promise.resolve(queue.splice(queuedIdx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`${name}: タイムアウトしました`));
        }, timeout);
        const waiter = { predicate, resolve, reject, timer };
        waiters.push(waiter);
      });
    },
    open() {
      return new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.predicate(msg));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
      if (queue.length > 200) queue.shift();
    }
  });
  return client;
}

async function waitForHealth(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('サーバーが起動しませんでした');
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    AUTO_UPDATE: '0',
    UPDATE_FIRST_DELAY_MS: '999999999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => (childLog += d.toString()));
child.stderr.on('data', (d) => (childLog += d.toString()));

let exitCode = 0;
const clients = [];

try {
  console.log('ws.test.js');
  const health = await waitForHealth();
  assert.strictEqual(health.ok, true);
  console.log('  ✓ サーバー起動 / ヘルスチェック');

  // --- 入室順マッチング ---
  const a = createClient('A');
  const b = createClient('B');
  clients.push(a, b);
  await Promise.all([a.open(), b.open()]);
  console.log('  ✓ WebSocket 接続');

  a.send({ t: 'match' });
  const queuedA = await a.wait((m) => m.t === 'queued');
  assert.strictEqual(queuedA.t, 'queued');
  console.log('  ✓ 先着はマッチング待ち');

  b.send({ t: 'match' });
  const startA = await a.wait((m) => m.t === 'start');
  const startB = await b.wait((m) => m.t === 'start');
  assert.strictEqual(startA.role, BLACK);
  assert.strictEqual(startB.role, WHITE);
  assert.ok(startA.id && startA.id === startB.id);
  assert.strictEqual(startA.state.board.length, 512);
  assert.deepStrictEqual(startA.state.board, startB.state.board);
  console.log(`  ✓ 対局開始（黒=A / 白=B, ${startA.id}）`);

  // --- エラー系 ---
  b.send({ t: 'move', x: 0, y: 0, z: 0 }); // 白の番ではなく黒の番
  const err = await b.wait((m) => m.t === 'error');
  assert.ok(err.message);
  console.log('  ✓ 番以外の着手が拒否される');

  // 黒は合法ではない場所への着手が拒否されること
  a.send({ t: 'move', x: 0, y: 0, z: 0 });
  const firstResp = await a.wait((m) => m.t === 'state' || m.t === 'error');
  assert.strictEqual(firstResp.t, 'error', '合法ではない手が受理されてしまいました');

  // --- ランダム対局を最後まで実施 ---
  let state = startA.state;
  const moves0 = legalMoves(state.board, state.turn);
  assert.ok(moves0.length > 0);

  const byRole = { [BLACK]: a, [WHITE]: b };
  let guard = 0;
  while (!state.over && guard < 600) {
    guard++;
    const mover = byRole[state.turn];
    const moves = legalMoves(state.board, state.turn);
    assert.ok(moves.length > 0, '合法手が無いのに終了していない');
    const m = moves[Math.floor(Math.random() * moves.length)];
    mover.send({ t: 'move', x: m.x, y: m.y, z: m.z });
    const resp = await mover.wait((r) => r.t === 'state' || r.t === 'error', 4000);
    assert.strictEqual(resp.t, 'state', `移動が拒否されました: ${JSON.stringify(resp)}`);
    state = resp.state;
    // 相手も同じ状態を受け取る
    const other = mover === a ? b : a;
    const otherState = await other.wait((r) => r.t === 'state' && r.state.moveCount === state.moveCount, 4000);
    assert.deepStrictEqual(otherState.state.board, state.board, 'クライアント間で盤面が不一致');
  }
  assert.ok(state.over, 'ゲームが終了しませんでした');
  const pieces = countPieces(state.board);
  assert.strictEqual(pieces.black + pieces.white, state.moveCount + 8);
  console.log(`  ✓ ランダム対局完了 (黒${pieces.black}:${pieces.white}白, ${state.moveCount}手)`);

  // --- 再戦 ---
  a.send({ t: 'rematch' });
  b.send({ t: 'rematch' });
  const newA = await a.wait((m) => m.t === 'start' && m.state.moveCount === 0, 4000);
  const newB = await b.wait((m) => m.t === 'start' && m.state.moveCount === 0, 4000);
  assert.deepStrictEqual(newA.state.board, newB.state.board);
  assert.strictEqual(newA.state.turn, BLACK);
  console.log('  ✓ 再戦（盤面リセット）');

  // --- 3人目は次のマッチを待つ。4人目とペアになる ---
  const c = createClient('C');
  const d = createClient('D');
  clients.push(c, d);
  await Promise.all([c.open(), d.open()]);
  c.send({ t: 'match' });
  await c.wait((m) => m.t === 'queued');
  d.send({ t: 'match' });
  const startC = await c.wait((m) => m.t === 'start');
  const startD = await d.wait((m) => m.t === 'start');
  assert.strictEqual(startC.role, BLACK);
  assert.strictEqual(startD.role, WHITE);
  assert.ok(startC.id !== startA.id);
  console.log('  ✓ 次の2人も入室順でマッチ（黒=C / 白=D）');

  // --- 存在しない対局への再接続 ---
  const e = createClient('E');
  clients.push(e);
  await e.open();
  e.send({ t: 'rejoin', id: 'ZZZZZZ' });
  const notFound = await e.wait((m) => m.t === 'error');
  assert.ok(notFound.message.includes('見つかりません'));
  console.log('  ✓ 存在しない対局のエラー');

  // --- キューから離脱すると次の人とマッチしない ---
  const f = createClient('F');
  const g = createClient('G');
  clients.push(f, g);
  await Promise.all([f.open(), g.open()]);
  f.send({ t: 'match' });
  await f.wait((m) => m.t === 'queued');
  f.send({ t: 'leave' });
  f.close();
  await sleep(150);
  g.send({ t: 'match' });
  const queuedG = await g.wait((m) => m.t === 'queued' || m.t === 'start');
  assert.strictEqual(queuedG.t, 'queued', '離脱した相手とマッチしてしまった');
  console.log('  ✓ キュー離脱後は次の人とマッチしない');

  // --- 退出通知 ---
  b.close();
  const leftMsg = await a.wait((m) => m.t === 'opponent_left', 4000);
  assert.ok(leftMsg);
  console.log('  ✓ 退出時の通知');

  // --- HTTP API ---
  const statusRes = await fetch(`${BASE}/api/update/status`);
  const status = await statusRes.json();
  assert.strictEqual(status.repo, 'HARUSINN0422/3Dosero');
  assert.strictEqual(status.enabled, false);
  console.log('  ✓ 更新ステータス API');

  const pageRes = await fetch(`${BASE}/`);
  const html = await pageRes.text();
  assert.ok(html.includes('3D オセロ'));
  console.log('  ✓ index.html 配信');

  const gameJs = await fetch(`${BASE}/lib/game.js`);
  assert.ok(gameJs.ok);
  assert.ok((gameJs.headers.get('content-type') || '').includes('javascript'));
  console.log('  ✓ 共有ロジック配信');

  const threeJs = await fetch(`${BASE}/vendor/three/three.module.js`);
  assert.ok(threeJs.ok);
  const orbit = await fetch(`${BASE}/vendor/three/addons/controls/OrbitControls.js`);
  assert.ok(orbit.ok);
  console.log('  ✓ Three.js 配信');

  console.log('\nすべての統合テスト成功');
} catch (err) {
  console.error('\nテスト失敗:', err);
  console.error('--- サーバーログ ---');
  console.error(childLog.slice(-3000));
  exitCode = 1;
} finally {
  for (const c of clients) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  child.kill('SIGTERM');
  await sleep(300);
  if (exitCode === 0 && child.exitCode === null) child.kill('SIGKILL');
}
process.exit(exitCode);
