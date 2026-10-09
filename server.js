// 3Dオセロ サーバー
// - 静的ファイル配信（Three.js の3Dボード UI）
// - WebSocket によるオンライン対戦（ルーム方式・サーバー権威のゲーム進行）
// - GitHub からの自動更新

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, BLACK, WHITE } from './lib/game.js';
import { createUpdater } from './lib/updater.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const AUTO_UPDATE = (process.env.AUTO_UPDATE ?? '1') !== '0';
const UPDATE_REPO = process.env.UPDATE_REPO || 'HARUSINN0422/3Dosero';
const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
const UPDATE_FIRST_DELAY_MS = Number(process.env.UPDATE_FIRST_DELAY_MS || 60_000);
const UPDATE_CHECK_INTERVAL_MS = Number(process.env.UPDATE_CHECK_INTERVAL_MS || 15 * 60_000);
const RESTART_AFTER_UPDATE = (process.env.RESTART_AFTER_UPDATE ?? '1') !== '0';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// アプリケーション / HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');

app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build'), { setHeaders: noCache }));
app.use('/vendor/three/addons', express.static(path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm'), { setHeaders: noCache }));
app.use('/lib/game.js', (req, res) => {
  noCache(res);
  res.type('application/javascript');
  res.sendFile(path.join(ROOT, 'lib', 'game.js'));
});
app.use(express.static(PUBLIC_DIR, { setHeaders: noCache }));

// --- API ---
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: '3dosero',
    version: pkg.version,
    uptimeSec: Math.round(process.uptime()),
    rooms: rooms.size,
  });
});

app.get('/api/update/status', (req, res) => {
  res.json(updater.status);
});

app.post('/api/update/check', async (req, res) => {
  const status = await updater.check();
  res.json(status);
});

app.post('/api/update/apply', async (req, res) => {
  try {
    await updater.check();
    if (!updater.status.updateAvailable) {
      return res.json({ applied: false, reason: 'already_up_to_date', status: updater.status });
    }
    if (!AUTO_UPDATE) {
      return res.json({ applied: false, reason: 'disabled', status: updater.status });
    }
    res.json({ applied: false, reason: 'applying', status: updater.status });
    // レスポンス送信後に適用（完了するとプロセスが再起動する）
    setTimeout(() => {
      updater.apply().catch((err) => log('手動更新に失敗:', String(err?.message || err)));
    }, 250);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// それ以外はすべてシングルページアプリの index.html を返す
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// オンライン対戦ルーム
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function connectedSeats(room) {
  return room.seats.filter((s) => s.connected);
}

function roleOfSeat(index) {
  return index === 0 ? BLACK : WHITE;
}

function seatByWs(ws) {
  for (const [code, room] of rooms) {
    const i = room.seats.findIndex((s) => s.ws === ws);
    if (i >= 0) return { room, seat: room.seats[i], role: roleOfSeat(i), index: i, code };
  }
  return null;
}

function clearGcTimer(room) {
  if (room.gcTimer) {
    clearTimeout(room.gcTimer);
    room.gcTimer = null;
  }
}

function maybeGc(room, code) {
  if (connectedSeats(room).length > 0) return;
  if (room.gcTimer) return;
  room.gcTimer = setTimeout(() => {
    if (connectedSeats(room).length === 0) {
      rooms.delete(code);
      log(`room ${code} を削除しました（無人）`);
    }
  }, 30_000);
  room.gcTimer.unref?.();
}

function broadcastRoom(room, obj) {
  for (const seat of room.seats) send(seat.ws, obj);
}

/** 各プレイヤーに個別の role を含む開始メッセージを送る */
function sendStart(room, code) {
  const state = room.game.serialize();
  const resumed = room.game.moveCount > 0;
  room.seats.forEach((seat, i) => {
    send(seat.ws, { t: 'start', code, role: roleOfSeat(i), state, resumed });
  });
}

function handleCreate(ws) {
  const existing = seatByWs(ws);
  if (existing) return send(ws, { t: 'error', message: 'すでに部屋に参加しています' });
  const code = makeRoomCode();
  const room = {
    code,
    seats: [
      { ws, connected: true },
      { ws: null, connected: false },
    ],
    game: new Game(),
    rematchVotes: new Set(),
    createdAt: Date.now(),
    gcTimer: null,
  };
  rooms.set(code, room);
  ws.roomCode = code;
  send(ws, { t: 'created', code, role: BLACK });
  log(`room ${code} を作成しました`);
}

function handleJoin(ws, codeRaw) {
  const code = String(codeRaw || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'error', message: '部屋が見つかりません（コードを確認してください）' });

  const existing = seatByWs(ws);
  if (existing) {
    if (existing.code === code) return send(ws, { t: 'error', message: 'すでにその部屋に参加しています' });
    leaveCurrentRoom(ws);
  }

  // 空席（未接続の席）を探す
  let seatIndex = room.seats.findIndex((s) => !s.connected);
  if (seatIndex < 0) {
    return send(ws, { t: 'error', message: '部屋が満員です' });
  }

  clearGcTimer(room);
  room.seats[seatIndex] = { ws, connected: true };
  ws.roomCode = code;
  room.rematchVotes.clear();

  const both = connectedSeats(room).length === 2;
  if (both) {
    sendStart(room, code);
    log(`room ${code}: 対戦開始`);
  } else {
    send(ws, { t: 'rejoined', code, role: roleOfSeat(seatIndex), state: room.game.serialize() });
    log(`room ${code}: 再接続/待機`);
  }
}

function leaveCurrentRoom(ws, { notify = true } = {}) {
  const info = seatByWs(ws);
  if (!info) return;
  const { room, seat, code } = info;
  seat.connected = false;
  seat.ws = null;
  ws.roomCode = null;
  room.rematchVotes.clear();

  const otherSeat = room.seats.find((s) => s.connected);
  if (otherSeat && notify) {
    send(otherSeat.ws, { t: 'opponent_left' });
  }
  maybeGc(room, code);
  log(`room ${code}: プレイヤーが退出しました（残り ${connectedSeats(room).length}）`);
}

function handleMove(ws, x, y, z) {
  const info = seatByWs(ws);
  if (!info) return send(ws, { t: 'error', message: '部屋にいません' });
  const { room, role, code } = info;
  const game = room.game;
  if (game.over) return send(ws, { t: 'error', message: 'ゲームは終了しています' });
  if (game.turn !== role) return send(ws, { t: 'error', message: '今の番ではありません' });

  const result = game.play(Number(x), Number(y), Number(z), role);
  if (!result.ok) return send(ws, { t: 'error', message: result.error });

  broadcastRoom(room, { t: 'state', state: game.serialize() });
}

function handleRematch(ws) {
  const info = seatByWs(ws);
  if (!info) return;
  const { room, role } = info;
  if (!room.game.over) return send(ws, { t: 'error', message: 'ゲーム終了後に再戦できます' });
  if (connectedSeats(room).length < 2) {
    return send(ws, { t: 'error', message: '相手が退出しています' });
  }
  room.rematchVotes.add(role);
  broadcastRoom(room, { t: 'rematch', by: role });
  if (room.rematchVotes.size >= 2) {
    room.rematchVotes.clear();
    room.game.reset();
    sendStart(room, info.code);
    log(`room ${info.code}: 再戦`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: 'error', message: '不正なメッセージです' });
    }
    try {
      switch (msg.t) {
        case 'create':
          handleCreate(ws);
          break;
        case 'join':
          handleJoin(ws, msg.code);
          break;
        case 'move':
          handleMove(ws, msg.x, msg.y, msg.z);
          break;
        case 'rematch':
          handleRematch(ws);
          break;
        case 'leave':
          leaveCurrentRoom(ws);
          break;
        case 'ping':
          send(ws, { t: 'pong' });
          break;
        default:
          send(ws, { t: 'error', message: `未知のメッセージ: ${msg.t}` });
      }
    } catch (err) {
      log('メッセージ処理エラー:', err);
      send(ws, { t: 'error', message: 'サーバーエラーが発生しました' });
    }
  });

  ws.on('close', () => leaveCurrentRoom(ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);
heartbeat.unref?.();

// ---------------------------------------------------------------------------
// GitHub 自動更新
// ---------------------------------------------------------------------------
const updater = createUpdater({
  repo: UPDATE_REPO,
  branch: UPDATE_BRANCH,
  appRoot: ROOT,
  dataDir: DATA_DIR,
  enabled: AUTO_UPDATE,
  onApplied: () => {
    if (RESTART_AFTER_UPDATE) scheduleRestart('GitHub 更新を適用しました');
  },
});

let restartScheduled = false;
function scheduleRestart(reason) {
  if (restartScheduled) return;
  restartScheduled = true;
  log(`${reason} — サーバーを再起動します…`);
  setTimeout(async () => {
    try {
      clearInterval(heartbeat);
      if (stopPeriodic) stopPeriodic();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });

      // 再起動後のログをファイルに追記する
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const fd = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
      const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      });
      child.unref();
      fs.closeSync(fd);
      log('新しいプロセスを起動しました。終了します。');
      process.exit(0);
    } catch (err) {
      log('再起動に失敗しました:', err);
      process.exit(1);
    }
  }, 400);
}

let stopPeriodic = null;

async function boot() {
  // 初回は GitHub の状態を「同期済み」として記録するだけ（勝手にダウンロードしない）
  try {
    await updater.ensureBaseline();
  } catch (err) {
    log('ベースライン記録に失敗（後で再試行します）:', String(err?.message || err));
  }

  server.listen(PORT, HOST, () => {
    log(`3Dオセロサーバー起動: http://${HOST}:${PORT}`);
    log(`モード: ローカル対戦 / オンライン対戦 / 自動更新 ${AUTO_UPDATE ? 'ON' : 'OFF'} (${UPDATE_REPO}@${UPDATE_BRANCH})`);
  });

  if (AUTO_UPDATE) {
    stopPeriodic = updater.startPeriodic({
      firstDelayMs: UPDATE_FIRST_DELAY_MS,
      intervalMs: UPDATE_CHECK_INTERVAL_MS,
    });
  }
}

boot();

// ---------------------------------------------------------------------------
// グレースフルシャットダウン
// ---------------------------------------------------------------------------
function shutdown(signal) {
  log(`${signal} を受信しました。終了します。`);
  clearInterval(heartbeat);
  if (stopPeriodic) stopPeriodic();
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
