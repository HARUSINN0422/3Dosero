// ゲームロジックのテスト
import assert from 'node:assert';
import {
  SIZE,
  BLACK,
  WHITE,
  EMPTY,
  idx,
  xOf,
  yOf,
  zOf,
  DIRS,
  initialBoard,
  flipsFor,
  legalMoves,
  countPieces,
  Game,
} from '../lib/game.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    throw err;
  }
}

console.log('game.test.js');

test('盤面は 8×8×8 = 512 マス', () => {
  const board = initialBoard();
  assert.strictEqual(board.length, SIZE * SIZE * SIZE);
  assert.strictEqual(board.length, 512);
});

test('方向は26通り', () => {
  assert.strictEqual(DIRS.length, 26);
});

test('index と座標の相互変換', () => {
  for (const [x, y, z] of [
    [0, 0, 0],
    [7, 7, 7],
    [3, 4, 5],
  ]) {
    const i = idx(x, y, z);
    assert.strictEqual(xOf(i), x);
    assert.strictEqual(yOf(i), y);
    assert.strictEqual(zOf(i), z);
  }
});

test('初期配置は中央2×2×2の市松模様（黒4・白4）', () => {
  const board = initialBoard();
  const c = countPieces(board);
  assert.strictEqual(c.black, 4);
  assert.strictEqual(c.white, 4);
  // ちょうど8マスのみ埋まっている
  let filled = 0;
  for (const v of board) if (v !== EMPTY) filled++;
  assert.strictEqual(filled, 8);
  // 中央2×2×2からのはみ出し確認
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY) {
      const [x, y, z] = [xOf(i), yOf(i), zOf(i)];
      assert.ok((x === 3 || x === 4) && (y === 3 || y === 4) && (z === 3 || z === 4));
    }
  }
  // 面隣接する石は必ず異色（市松）。※斜めは同色でよい
  const FACE_DIRS = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let i = 0; i < board.length; i++) {
    if (board[i] === EMPTY) continue;
    for (const [dx, dy, dz] of FACE_DIRS) {
      const [x, y, z] = [xOf(i) + dx, yOf(i) + dy, zOf(i) + dz];
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || z < 0 || z >= SIZE) continue;
      const v = board[idx(x, y, z)];
      if (v !== EMPTY) assert.notStrictEqual(v, board[i], `(${x},${y},${z}) が同色隣接`);
    }
  }
});

test('初期状態で黒・白ともに合法手が存在する', () => {
  const board = initialBoard();
  assert.ok(legalMoves(board, BLACK).length > 0);
  assert.ok(legalMoves(board, WHITE).length > 0);
});

test('X軸1本のラインの反転', () => {
  const board = new Uint8Array(512);
  board[idx(0, 0, 0)] = BLACK;
  board[idx(1, 0, 0)] = WHITE;
  const flips = flipsFor(board, 2, 0, 0, BLACK);
  assert.ok(flips);
  assert.deepStrictEqual(flips.sort(), [idx(1, 0, 0)]);
  // 置けない場所
  assert.strictEqual(flipsFor(board, 1, 0, 0, BLACK), null);
  // 反転なしの場所
  assert.strictEqual(flipsFor(board, 5, 5, 5, BLACK), null);
});

test('空間内の斜め（3方向）の反転', () => {
  const board = new Uint8Array(512);
  board[idx(1, 1, 1)] = BLACK;
  board[idx(2, 2, 2)] = BLACK;
  board[idx(0, 0, 0)] = WHITE; // その先に白（挟み込みのアンカー）
  // 白が (3,3,3) に置くと斜め一直線上の黒2個が挟まれる
  const flips = flipsFor(board, 3, 3, 3, WHITE);
  assert.ok(flips);
  assert.deepStrictEqual([...flips].sort((a, b) => a - b), [idx(1, 1, 1), idx(2, 2, 2)].sort((a, b) => a - b));
});

test('1手で複数方向同時に反転できる', () => {
  const board = new Uint8Array(512);
  // 黒が (5,5,5) に置くと X方向・Y方向の白がともに挟める
  board[idx(4, 5, 5)] = WHITE;
  board[idx(5, 4, 5)] = WHITE;
  board[idx(3, 5, 5)] = BLACK;
  board[idx(5, 3, 5)] = BLACK;
  const flips = flipsFor(board, 5, 5, 5, BLACK);
  assert.ok(flips);
  assert.strictEqual(flips.length, 2);
  assert.ok(flips.includes(idx(4, 5, 5)));
  assert.ok(flips.includes(idx(5, 4, 5)));
});

test('パス判定と終了判定', () => {
  const g = new Game();
  // 白に合法手が無く、黒にも無ければ終了
  g.board = new Uint8Array(512);
  g.board[idx(0, 0, 0)] = BLACK;
  g.board[idx(0, 0, 1)] = BLACK;
  g.board[idx(7, 7, 7)] = WHITE;
  g.turn = WHITE;
  g.ensureTurn();
  // 白: 黒を挟める場所が無い / 黒: 角の白を挟めない → 終了
  assert.ok(g.over);
  assert.strictEqual(g.winner, BLACK); // 2:1
});

test('白が置けない場合は黒にパスが適用される', () => {
  const g = new Game();
  g.board = new Uint8Array(512);
  // 黒 (0,0,0)(1,1,1) / 白 (2,2,2) の斜め一直線
  g.board[idx(0, 0, 0)] = BLACK;
  g.board[idx(1, 1, 1)] = BLACK;
  g.board[idx(2, 2, 2)] = WHITE;
  g.turn = WHITE;
  assert.strictEqual(legalMoves(g.board, WHITE).length, 0, 'この配置で白は動けないはず');
  assert.ok(legalMoves(g.board, BLACK).length > 0, 'この配置で黒は動けるはず');
  g.ensureTurn();
  assert.strictEqual(g.turn, BLACK);
  assert.ok(g.notice && g.notice.type === 'pass');
  assert.strictEqual(g.notice.player, WHITE);
  // 黒は (3,3,3) で白を挟める
  const res = g.play(3, 3, 3, BLACK);
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(g.board[idx(2, 2, 2)], BLACK);
});

test('ランダム対局が正常に終了する（100局）', () => {
  for (let n = 0; n < 100; n++) {
    const g = new Game();
    let plies = 0;
    while (!g.over && plies < 600) {
      const moves = g.legalMoves();
      assert.ok(moves.length > 0, 'over でないのに合法手が無い');
      const m = moves[Math.floor(Math.random() * moves.length)];
      const res = g.play(m.x, m.y, m.z);
      assert.ok(res.ok);
      plies++;
    }
    assert.ok(g.over, '終了しない');
    const c = countPieces(g.board);
    assert.strictEqual(c.black + c.white, g.moveCount + 8, '石数と着手数が合わない');
    if (g.winner !== 0) {
      assert.ok(g.winner === BLACK ? c.black > c.white : c.white > c.black);
    } else {
      assert.strictEqual(c.black, c.white);
    }
    // 盤面の値はすべて0/1/2
    for (const v of g.board) assert.ok(v === 0 || v === 1 || v === 2);
  }
});

test('serialize → ボード配列が512要素', () => {
  const g = new Game();
  const s = g.serialize();
  assert.strictEqual(s.board.length, 512);
  assert.strictEqual(s.turn, BLACK);
  assert.strictEqual(s.over, false);
  assert.deepStrictEqual(s.counts, { black: 4, white: 4 });
});

console.log(`\n${passed} テスト成功`);
