// 3Dオセロ（8×8×8）の共有ゲームロジック
// サーバー（Node.js）とクライアント（ブラウザ）の両方から import して使います。

export const SIZE = 8;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** 全26方向（上下左右・斜め・空間内の斜め） */
export const DIRS = (() => {
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0) dirs.push([dx, dy, dz]);
      }
    }
  }
  return dirs;
})();

export const idx = (x, y, z) => x + y * SIZE + z * SIZE * SIZE;
export const xOf = (i) => i % SIZE;
export const yOf = (i) => Math.floor(i / SIZE) % SIZE;
export const zOf = (i) => Math.floor(i / (SIZE * SIZE));
export const inBounds = (x, y, z) =>
  x >= 0 && x < SIZE && y >= 0 && y < SIZE && z >= 0 && z < SIZE;
export const other = (p) => (p === BLACK ? WHITE : BLACK);
export const playerName = (p) => (p === BLACK ? '黒' : p === WHITE ? '白' : '不明');
export const COLOR_HEX = { [BLACK]: 0x17171d, [WHITE]: 0xf2f3f6 };

/**
 * 初期配置: 中央 2×2×2 の市松模様（黒4・白4）。
 * 黒 = (x+y+z) が偶数、白 = 奇数。
 */
export function initialBoard() {
  const board = new Uint8Array(SIZE * SIZE * SIZE);
  for (const x of [3, 4]) {
    for (const y of [3, 4]) {
      for (const z of [3, 4]) {
        board[idx(x, y, z)] = (x + y + z) % 2 === 0 ? BLACK : WHITE;
      }
    }
  }
  return board;
}

/**
 * (x,y,z) に player が置いたとき反転する相手の石の index 群。
 * 置けない場合は null。
 */
export function flipsFor(board, x, y, z, player) {
  if (!inBounds(x, y, z) || board[idx(x, y, z)] !== EMPTY) return null;
  const opp = other(player);
  const all = [];
  for (const [dx, dy, dz] of DIRS) {
    let cx = x + dx;
    let cy = y + dy;
    let cz = z + dz;
    const line = [];
    while (inBounds(cx, cy, cz)) {
      const v = board[idx(cx, cy, cz)];
      if (v === opp) {
        line.push(idx(cx, cy, cz));
        cx += dx;
        cy += dy;
        cz += dz;
        continue;
      }
      if (v === player && line.length > 0) {
        all.push(...line);
      }
      break;
    }
  }
  return all.length > 0 ? all : null;
}

/** player が置ける場所の一覧 */
export function legalMoves(board, player) {
  const moves = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY) continue;
    const flips = flipsFor(board, xOf(i), yOf(i), zOf(i), player);
    if (flips) moves.push({ idx: i, x: xOf(i), y: yOf(i), z: zOf(i), flips });
  }
  return moves;
}

export function countPieces(board) {
  let black = 0;
  let white = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === BLACK) black++;
    else if (board[i] === WHITE) white++;
  }
  return { black, white };
}

/** 1つのゲーム进行状況を表すクラス（サーバーが権威を持つ） */
export class Game {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = initialBoard();
    this.turn = BLACK;
    this.over = false;
    this.winner = 0; // 0=引き分け
    this.lastMove = null;
    this.notice = null;
    this.moveCount = 0;
    this.ensureTurn();
  }

  legalMoves(player = this.turn) {
    return legalMoves(this.board, player);
  }

  /**
   * 石を置く。player は現在の番のプレイヤーでなければならない。
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  play(x, y, z, player = this.turn) {
    if (this.over) return { ok: false, error: 'ゲームは終了しています' };
    if (player !== this.turn) return { ok: false, error: '今の番ではありません' };
    const flips = flipsFor(this.board, x, y, z, player);
    if (!flips) return { ok: false, error: 'そこには置けません' };

    const i = idx(x, y, z);
    this.board[i] = player;
    for (const f of flips) this.board[f] = player;
    this.lastMove = { idx: i, player, flipped: flips };
    this.moveCount++;
    this.notice = null;
    this._advance();
    return { ok: true };
  }

  /** 置いた後の番進め（パス判定・終了判定） */
  _advance() {
    const opp = other(this.turn);
    if (legalMoves(this.board, opp).length > 0) {
      this.turn = opp;
      return;
    }
    if (legalMoves(this.board, this.turn).length > 0) {
      // 相手が置けないのでパス（番は変わらない）
      this.notice = { type: 'pass', player: opp };
      return;
    }
    this._finish();
  }

  /** 現在の番に着手可能な場所がない場合の保険処理 */
  ensureTurn() {
    if (this.over) return false;
    if (legalMoves(this.board, this.turn).length > 0) return false;
    const opp = other(this.turn);
    if (legalMoves(this.board, opp).length > 0) {
      this.notice = { type: 'pass', player: this.turn };
      this.turn = opp;
      return true;
    }
    this._finish();
    return true;
  }

  _finish() {
    this.over = true;
    const c = countPieces(this.board);
    this.winner = c.black > c.white ? BLACK : c.white > c.black ? WHITE : 0;
    this.notice = { type: 'gameover' };
  }

  serialize() {
    const counts = countPieces(this.board);
    return {
      board: Array.from(this.board),
      turn: this.turn,
      over: this.over,
      winner: this.winner,
      counts,
      lastMove: this.lastMove,
      notice: this.notice,
      moveCount: this.moveCount,
    };
  }
}
