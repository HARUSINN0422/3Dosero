// WebSocket クライアント（オンライン対戦用）
// 接続・再接続・キューイングを担当。メッセージは JSON で送受信する。

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map(); // type -> [cb]
    this.queue = [];
    this.wantOpen = false;
    this.openPromise = null;
    this.reconnectTries = 0;
    this.closedIntentionally = false;
  }

  on(type, cb) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(cb);
    return this;
  }

  off(type, cb) {
    const list = this.handlers.get(type);
    if (list) {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    }
    return this;
  }

  /** 特定イベントを1回だけ処理する（タイムアウト付き） */
  onceFiltered(type, predicate, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const handler = (payload) => {
        if (predicate(payload)) {
          cleanup();
          resolve(payload);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(type, handler);
      };
      this.on(type, handler);
    });
  }

  _emit(type, payload) {
    for (const cb of this.handlers.get(type) || []) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`handler error [${type}]`, err);
      }
    }
  }

  get url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 接続（既に接続中ならそのまま）。 */
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.wantOpen = true;
    this.closedIntentionally = false;

    this.openPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        this.openPromise = null;
        reject(err);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        this.openPromise = null;
        this.reconnectTries = 0;
        this._emit('open');
        // キューを送る
        const q = this.queue.splice(0);
        for (const msg of q) this.send(msg);
        resolve();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        this._emit('message', msg);
        if (msg && msg.t) this._emit(msg.t, msg);
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          this.openPromise = null;
          reject(new Error('WebSocket 接続に失敗しました'));
        }
      };
      ws.onclose = () => {
        const wasIntentional = ws.__intentionalClose || this.closedIntentional;
        if (this.ws === ws) this.ws = null;
        this.openPromise = null;
        if (!wasIntentional) this._emit('close', { intentional: false });
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket 接続が閉じられました'));
        }
      };
    });
    return this.openPromise;
  }

  /** メッセージ送信（未接続ならキューに貯める） */
  send(obj) {
    if (this.connected) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    this.queue.push(obj);
    return false;
  }

  /** 意図的な切断 */
  close() {
    this.closedIntentionally = true;
    this.wantOpen = false;
    this.queue.length = 0;
    if (this.ws) {
      const ws = this.ws;
      ws.__intentionalClose = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** 切断後に再接続を試みる */
  async reconnect() {
    this.close();
    this.closedIntentionally = false;
    await this.connect();
  }
}
