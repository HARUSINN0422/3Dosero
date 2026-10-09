// 3Dオセロ メイン制御
// 画面遷移・ローカル対戦・オンライン対戦・HUD をまとめて管理する。

import { Game, legalMoves, playerName, BLACK, WHITE, SIZE } from '/lib/game.js';
import { Board3D } from '/js/board3d.js';
import { Net } from '/js/net.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  container: $('scene-container'),
  hud: $('hud'),
  modeLabel: $('mode-label'),
  roomLabel: $('room-label'),
  countBlack: $('count-black'),
  countWhite: $('count-white'),
  turnStone: $('turn-stone'),
  turnText: $('turn-text'),
  turnIndicator: $('turn-indicator'),
  menu: $('menu'),
  onlineMenu: $('online-menu'),
  inputCode: $('input-code'),
  joinError: $('join-error'),
  waiting: $('waiting'),
  roomCode: $('room-code'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultBlack: $('result-black'),
  resultWhite: $('result-white'),
  resultMessage: $('result-message'),
  resultActions: $('result-actions'),
  rematchStatus: $('rematch-status'),
  disconnect: $('disconnect'),
  disconnectText: $('disconnect-text'),
  rulesModal: $('rules-modal'),
  toasts: $('toasts'),
  updateStatus: $('update-status'),
  btnRematch: $('btn-rematch'),
};

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const state = {
  mode: null, // null | 'local' | 'online'
  game: null, // Game インスタンス（ローカル用）
  net: new Net(),
  online: {
    code: null,
    role: null, // BLACK または WHITE
    gameState: null, // サーバーからの最新状態
    reconnecting: false,
    reconnectTries: 0,
    leaveIntent: false,
    lock: false, // create/join の多重送信防止
    awaitingState: false, // 着手後の状態待ち
  },
  lastNotice: null,
};

const board = new Board3D(els.container, {
  onCellClick: handleCellClick,
});

// ---------------------------------------------------------------------------
// 画面切り替えヘルパー
// ---------------------------------------------------------------------------
function showScreen(name) {
  els.menu.classList.toggle('hidden', name !== 'menu');
  els.waiting.classList.toggle('hidden', name !== 'waiting');
  if (name !== 'result') els.result.classList.add('hidden');
  els.disconnect.classList.add('hidden');
  const inGame = name === 'game';
  els.hud.classList.toggle('hidden', !inGame);
}

function toast(message, kind = '', duration = 2800) {
  const div = document.createElement('div');
  div.className = `toast ${kind ? `toast-${kind}` : ''}`;
  div.textContent = message;
  els.toasts.appendChild(div);
  setTimeout(() => {
    div.classList.add('toast-out');
    setTimeout(() => div.remove(), 350);
  }, duration);
}

// ---------------------------------------------------------------------------
// 盤面・HUD の更新
// ---------------------------------------------------------------------------
function applyState(g, { reset = false } = {}) {
  board.setBoard(g.board, { reset, lastMove: g.lastMove });

  const moves = g.over ? [] : legalMoves(g.board, g.turn);
  board.setHints(moves, g.turn);

  const myTurn = isMyTurn(g);
  board.setInteractive(myTurn && !g.over);

  updateHud(g);

  // パスなどの通知
  const noticeKey = g.notice ? JSON.stringify(g.notice) : null;
  if (noticeKey && noticeKey !== state.lastNotice) {
    if (g.notice.type === 'pass') {
      toast(`${playerName(g.notice.player)}は置けません — パス`, 'warn');
    }
  }
  state.lastNotice = noticeKey;

  if (g.over) {
    showResult(g);
  } else {
    els.result.classList.add('hidden');
  }
}

function isMyTurn(g) {
  if (!g || g.over) return false;
  if (state.mode === 'local') return true;
  if (state.mode === 'online') return g.turn === state.online.role;
  return false;
}

function updateHud(g) {
  els.countBlack.textContent = g.counts.black;
  els.countWhite.textContent = g.counts.white;

  els.turnStone.className = `stone ${g.turn === BLACK ? 'stone-black' : 'stone-white'}`;
  if (g.over) {
    els.turnText.textContent = '対局終了';
    els.turnIndicator.classList.add('waiting');
  } else {
    let text = `${playerName(g.turn)}の番`;
    if (state.mode === 'online') {
      text += g.turn === state.online.role ? '（あなた）' : '（相手）';
    }
    els.turnText.textContent = text;
    els.turnIndicator.classList.toggle('waiting', !isMyTurn(g));
  }
}

function showResult(g) {
  const black = g.counts.black;
  const white = g.counts.white;
  els.resultBlack.textContent = black;
  els.resultWhite.textContent = white;

  if (g.winner === 0) {
    els.resultTitle.textContent = '引き分け';
    els.resultMessage.textContent = `${black} : ${white}`;
  } else {
    const winnerName = playerName(g.winner);
    if (state.mode === 'online') {
      const won = g.winner === state.online.role;
      els.resultTitle.textContent = won ? 'あなたの勝ち！' : `${winnerName}の勝ち`;
    } else {
      els.resultTitle.textContent = `${winnerName}の勝ち！`;
    }
    els.resultMessage.textContent = `最終スコア ${black} : ${white}`;
  }

  els.rematchStatus.classList.add('hidden');
  els.rematchStatus.textContent = '';
  els.btnRematch.disabled = false;

  if (state.mode === 'online') {
    els.btnRematch.textContent = 'もう一度対局';
  } else {
    els.btnRematch.textContent = 'もう一度対局';
  }
  els.result.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 石をクリックしたとき
// ---------------------------------------------------------------------------
function handleCellClick(cell) {
  if (state.mode === 'local') {
    const g = state.game;
    if (!g || g.over) return;
    const res = g.play(cell.x, cell.y, cell.z);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    applyState(g.serialize());
    return;
  }

  if (state.mode === 'online') {
    const gs = state.online.gameState;
    if (!gs || gs.over) return;
    if (gs.turn !== state.online.role) return;
    if (state.online.awaitingState) return;
    state.online.awaitingState = true;
    state.net.send({ t: 'move', x: cell.x, y: cell.y, z: cell.z });
  }
}

// ---------------------------------------------------------------------------
// ローカル対戦
// ---------------------------------------------------------------------------
function startLocalGame() {
  state.mode = 'local';
  state.game = new Game();
  els.modeLabel.textContent = 'ローカル対戦';
  els.roomLabel.classList.add('hidden');
  showScreen('game');
  applyState(state.game.serialize(), { reset: true });
}

// ---------------------------------------------------------------------------
// オンライン対戦
// ---------------------------------------------------------------------------
async function ensureConnected() {
  try {
    await state.net.connect();
    return true;
  } catch {
    return false;
  }
}

async function createRoom() {
  if (state.online.lock) return;
  els.joinError.classList.add('hidden');
  const ok = await ensureConnected();
  if (!ok) {
    showJoinError('サーバーに接続できません。ネットワークを確認してください。');
    return;
  }
  state.online.leaveIntent = false;
  state.online.lock = true;
  state.net.send({ t: 'create' });
}

async function joinRoom() {
  if (state.online.lock) return;
  els.joinError.classList.add('hidden');
  const code = els.inputCode.value.trim().toUpperCase();
  if (!code) {
    showJoinError('招待コードを入力してください。');
    return;
  }
  const ok = await ensureConnected();
  if (!ok) {
    showJoinError('サーバーに接続できません。ネットワークを確認してください。');
    return;
  }
  state.online.leaveIntent = false;
  state.online.lock = true;
  state.net.send({ t: 'join', code });
}

function showJoinError(msg) {
  els.joinError.textContent = msg;
  els.joinError.classList.remove('hidden');
}

function enterOnlineMenu() {
  els.onlineMenu.classList.remove('hidden');
  els.joinError.classList.add('hidden');
  ensureConnected(); // 接続を試みる（失敗は参加/作成時に報告）
}

function backToMenu() {
  state.mode = null;
  state.game = null;
  state.online.gameState = null;
  state.online.code = null;
  state.online.role = null;
  state.online.leaveIntent = true;
  state.online.lock = false;
  state.online.awaitingState = false;
  if (state.net.connected) state.net.send({ t: 'leave' });
  board.clearHints();
  board.setInteractive(false);
  showScreen('menu');
}

function handleOnlineStart(msg) {
  state.mode = 'online';
  state.online.lock = false;
  state.online.code = msg.code;
  state.online.role = msg.role;
  state.online.gameState = msg.state;
  state.online.reconnecting = false;
  state.online.reconnectTries = 0;
  state.online.awaitingState = false;
  state.lastNotice = null;

  els.modeLabel.textContent = 'オンライン対戦';
  els.roomLabel.textContent = `部屋 ${msg.code}`;
  els.roomLabel.classList.remove('hidden');
  showScreen('game');
  applyState(msg.state, { reset: true });

  if (msg.state.moveCount > 0 && !msg.state.over) {
    toast('再接続しました。対局を再開します。');
  } else {
    toast(msg.state.turn === state.online.role ? '対局開始！あなたの番です（黒）' : '対局開始！相手の番です（あなたは白）');
  }
}

function handleOpponentLeft() {
  toast('対戦相手が切断しました（再接続を待っています）', 'warn', 4000);
}

function handleRematchVote(msg) {
  if (msg.by === state.online.role) {
    els.btnRematch.disabled = true;
    els.rematchStatus.textContent = '再戦を提案しています… 相手の確認待ちです。';
    els.rematchStatus.classList.remove('hidden');
  } else {
    toast('相手が再戦を希望しています', 'warn');
    els.rematchStatus.textContent = '相手が再戦を希望しています。「もう一度対局」で応じてください。';
    els.rematchStatus.classList.remove('hidden');
  }
}

/** サーバー切断時の自動再接続 */
async function attemptReconnect() {
  if (state.online.leaveIntent) return;
  if (state.online.reconnecting) return;
  const waiting = !els.waiting.classList.contains('hidden');
  if (state.mode !== 'online' && !waiting) return;

  state.online.reconnecting = true;
  const code = state.online.code;
  if (!code) {
    state.online.reconnecting = false;
    return;
  }

  while (state.online.reconnectTries < 12 && !state.online.leaveIntent) {
    state.online.reconnectTries++;
    try {
      await state.net.reconnect();
      // 部屋に再参加を試みる
      const joinPromise = state.net.onceFiltered(
        'message',
        (m) => m.t === 'start' || m.t === 'rejoined' || m.t === 'error',
        4500
      );
      state.net.send({ t: 'join', code });
      const resp = await joinPromise;
      if (resp && (resp.t === 'start' || resp.t === 'rejoined')) {
        state.online.reconnecting = false;
        if (resp.t === 'rejoined') {
          els.roomCode.textContent = code;
          showScreen('waiting');
        }
        toast('再接続しました');
        return;
      }
      if (resp && resp.t === 'error') {
        state.online.reconnecting = false;
        showDisconnect(`再接続できませんでした: ${resp.message}`);
        return;
      }
    } catch {
      /* 次のリトライへ */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  state.online.reconnecting = false;
  if (!state.online.leaveIntent) {
    showDisconnect('サーバーに再接続できませんでした。');
  }
}

function showDisconnect(text) {
  els.disconnectText.textContent = text;
  els.disconnect.classList.remove('hidden');
  els.hud.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// ネットワークイベント
// ---------------------------------------------------------------------------
const net = state.net;

net.on('created', (msg) => {
  state.online.lock = false;
  state.online.code = msg.code;
  state.online.role = msg.role;
  els.roomCode.textContent = msg.code;
  showScreen('waiting');
});

net.on('rejoined', (msg) => {
  state.online.lock = false;
  state.online.code = msg.code;
  state.online.role = msg.role;
  state.online.gameState = msg.state;
  // 相手（または自分）が揃うまで待機
  els.roomCode.textContent = msg.code;
  showScreen('waiting');
  toast('部屋に再接続しました。相手を待っています…');
});

net.on('start', (msg) => handleOnlineStart(msg));

net.on('state', (msg) => {
  state.online.awaitingState = false;
  state.online.gameState = msg.state;
  if (state.mode === 'online') applyState(msg.state);
});

net.on('rematch', (msg) => handleRematchVote(msg));

net.on('opponent_left', handleOpponentLeft);

net.on('error', (msg) => {
  state.online.lock = false;
  state.online.awaitingState = false;
  // 再接続処理中は attemptReconnect 側が画面を制御する
  if (state.online.reconnecting) return;
  // 待機・メニュー中のエラーは画面に表示、游戏中はトースト
  if (!els.waiting.classList.contains('hidden')) {
    backToMenu();
    showJoinError(msg.message || 'エラーが発生しました');
  } else if (!els.menu.classList.contains('hidden') && !els.onlineMenu.classList.contains('hidden')) {
    showJoinError(msg.message || 'エラーが発生しました');
  } else if (state.mode) {
    toast(msg.message || 'エラーが発生しました', 'error');
  }
});

net.on('close', ({ intentional }) => {
  if (intentional) return;
  if (state.online.leaveIntent) return;
  state.online.awaitingState = false;
  const waiting = !els.waiting.classList.contains('hidden');
  if (state.mode !== 'online' && !waiting) return;
  toast('接続が切断されました。再接続します…', 'warn');
  state.online.reconnectTries = 0;
  attemptReconnect();
});

// ---------------------------------------------------------------------------
// イベント登録
// ---------------------------------------------------------------------------
$('btn-local').addEventListener('click', startLocalGame);

$('btn-online').addEventListener('click', enterOnlineMenu);

$('btn-create').addEventListener('click', createRoom);

$('btn-join').addEventListener('click', joinRoom);
els.inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
els.inputCode.addEventListener('input', () => {
  const pos = els.inputCode.selectionStart;
  els.inputCode.value = els.inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  els.inputCode.setSelectionRange(pos, pos);
  els.joinError.classList.add('hidden');
});

$('btn-copy').addEventListener('click', async () => {
  const code = els.roomCode.textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('コードをコピーしました');
  } catch {
    // フォバック: 選択状態にする
    const range = document.createRange();
    range.selectNodeContents(els.roomCode);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('コードを選択しました（コピーして共有してください）');
  }
});

$('btn-wait-back').addEventListener('click', backToMenu);

$('btn-leave').addEventListener('click', () => {
  if (state.mode === 'online' && state.online.gameState && !state.online.gameState.over) {
    if (!confirm('対局を途中で諦めてメニューへ戻りますか？')) return;
  }
  backToMenu();
});

els.btnRematch.addEventListener('click', () => {
  if (state.mode === 'local') {
    state.game = new Game();
    els.result.classList.add('hidden');
    applyState(state.game.serialize(), { reset: true });
    return;
  }
  if (state.mode === 'online') {
    els.btnRematch.disabled = true;
    els.rematchStatus.textContent = '再戦を提案しています…';
    els.rematchStatus.classList.remove('hidden');
    state.net.send({ t: 'rematch' });
  }
});

$('btn-to-menu').addEventListener('click', backToMenu);

$('btn-reconnect').addEventListener('click', async () => {
  els.disconnect.classList.add('hidden');
  state.online.reconnectTries = 0;
  state.online.reconnecting = false;
  await attemptReconnect();
  if (state.mode === 'online' && els.disconnect.classList.contains('hidden')) {
    els.hud.classList.remove('hidden');
  }
});

$('btn-disconnect-menu').addEventListener('click', backToMenu);

// ルールモーダル
const openRules = () => els.rulesModal.classList.remove('hidden');
const closeRules = () => els.rulesModal.classList.add('hidden');
$('btn-rules').addEventListener('click', openRules);
$('btn-rules-menu').addEventListener('click', openRules);
$('btn-rules-close').addEventListener('click', closeRules);
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) closeRules();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRules();
});

// ---------------------------------------------------------------------------
// 更新状況の表示
// ---------------------------------------------------------------------------
async function refreshUpdateStatus() {
  try {
    const res = await fetch('/api/update/status');
    const s = await res.json();
    const ver = 'v1.0.0';
    if (s.updateAvailable) {
      els.updateStatus.innerHTML = '';
      const btn = document.createElement('button');
      btn.className = 'update-link';
      btn.textContent = `📦 新しいバージョンがあります（${(s.remoteSha || '').slice(0, 7)}）— 更新する`;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '更新中…（サーバーが再起動します）';
        try {
          await fetch('/api/update/apply', { method: 'POST' });
        } catch {
          /* 再起動で接続が切れるのは正常 */
        }
        setTimeout(() => {
          btn.textContent = '更新しました。ページを再読み込みしてください。';
        }, 4000);
      });
      els.updateStatus.appendChild(btn);
    } else {
      const sha = s.localSha ? s.localSha.slice(0, 7) : '';
      els.updateStatus.textContent = `${ver}・GitHub 同期済み${sha ? ` (${sha})` : ''}`;
    }
  } catch {
    els.updateStatus.textContent = ver;
  }
}

refreshUpdateStatus();

// 初期表示
showScreen('menu');
