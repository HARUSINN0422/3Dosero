# 3Dosero — 3Dオセロ 8×8×8

通常 8×8 のオセロを **8×8×8 の立体ボード**にした 3D オセロです。石は **球** になります。
Node.js サーバーが HTML を公開するので、ブラウザでアクセスして遊べます。

- 🎮 **ローカル対戦**: 1台の端末で2人交互にプレイ
- 🌐 **オンライン対戦**: 招待コードで部屋を作り、離れた2台どうしで対戦（WebSocket・サーバー権威で公平な進行）
- 🔄 **GitHub 自動更新**: GitHub に更新があれば自動でダウンロードして適用・再起動
- 🖱️ 3D視点の回転・ズーム、合法手ヒント、反転アニメーション対応（PC・スマホ）

---

## 初期設定のやり方

### 1. 必要なもの

| 項目 | 備考 |
|---|---|
| **Node.js 18 以上** | [nodejs.org](https://nodejs.org/) からインストール。`node --version` で確認 |
| **npm** | Node.js に付属 |
| （任意）**git** | GitHub から取得する場合 |
| （任意）**curl / tar** | 自動更新のダウンロードに使用（通常はOSに付属） |

### 2. リポジトリを取得する

```bash
git clone https://github.com/HARUSINN0422/3Dosero.git
cd 3Dosero
```

（zip でダウンロードして展開してもOKです）

### 3. 依存パッケージをインストールする

```bash
npm install
```

これで `express`（HTTPサーバー）・`ws`（WebSocket）・`three`（3D描画）が入ります。

### 4. サーバーを起動する

```bash
npm start
```

起動ログ:

```
3Dオセロサーバー起動: http://0.0.0.0:3009
モード: ローカル対戦 / オンライン対戦 / 自動更新 ON (HARUSINN0422/3Dosero@main)
```

### 5. ブラウザでアクセスする

- **自分だけの場合**: <http://localhost:3009>
- **同一ネットワークの別端末から**: `http://<このPCのIPアドレス>:3009`
  - 例: `http://192.168.1.10:3009`（PCのIPは `ipconfig` / `ip addr` で確認）
  - Windows/macOS の場合はファイアウォールでポート **TCP 3009** の許可が必要なことがあります

起動して画面が開いたら、あとは **「ローカル対戦」** か **「オンライン対戦」** を選んで開始です。

---

## 遊び方

### ローカル対戦（1台で2人）

1. メニューで **「ローカル対戦」** をタップ
2. 光っている場所（合法手ヒント）をクリック／タップして石を置く
3. 黒と白が交互に手を進め、両者置けなくなったら終了
4. 球の数が多い方が勝ち

**視点操作**: ドラッグで回転 / ホイール（ピンチ）でズーム / 右ドラッグで移動

### オンライン対戦（離れた2台）

1. どちらかが **「オンライン対戦」→「部屋を作成」**
2. 表示された **招待コード**（4文字）を相手に送る（コピー button あり）
3. 相手が **「オンライン対戦」→ コード入力 →「参加する」**
4. 対局開始 — **黒 = 作成者 / 白 = 参加者**
5. 先に切断された側は自動で再接続を試みます。ゲーム終了後は両者が「もう一度対局」を押すと再戦できます

> 部屋は最大2人です。コードが違う・満員の場合はエラー表示されます。

### ルール（3D版）

- ボードは 8×8×8 = **512マス**。最初は中央の 2×2×2 に黒4・白4が市松模様で配置されます
- 置ける場所は、**26方向すべて**（上下左右・斜め・空間内の斜め）の直線で相手の球を自分の球で挟める場所
- 挟んだ相手の球は線上のすべてが反転します（1手でいくつも反転可能）
- 置けない側はパス。双方が置けなくなったら終了

---

## GitHub からの自動更新

GitHub リポジトリ（既定: `HARUSINN0422/3Dosero` の `main` ブランチ）に新しいコミットがあれば、
サーバーが自動で更新をダウンロードしてファイルを差し替え、**プロセスを自動再起動**します。

### 動作の仕組み

1. **起動直後**: 現在の GitHub の状態（最新コミット SHA）を `data/last_sync.json` に「同期済み」として記録（この時点では何もダウンロードしません）
2. **定期チェック**: 既定で60秒後に行う初回チェック以降、**常時1分ごと**に最新コミットを照会
3. **差分があれば**: `codeload.github.com` からソースを tar.gz で取得 → `node_modules` / `.git` / `data` / `logs` を除いて上書き → `package.json` が変わっていれば `npm install` を実行 → **自動再起動**
4. **再起動後**: クライアントは自動で再接続します（対局中の場合は部屋に復帰）

### 手動で更新する方法

- **ブラウザ**: メニュー下部の「📦 新しいバージョンがあります — 更新する」をクリック
- **curl**:

  ```bash
  curl -X POST http://localhost:3009/api/update/apply
  ```

- **コマンドライン**:

  ```bash
  npm run update    # GitHub をチェックして差分を適用
  # → 「サーバーを再起動してください（npm start）」と出たら再起動
  ```

### 更新状態の確認

```bash
curl http://localhost:3009/api/update/status
```

```json
{
  "repo": "HARUSINN0422/3Dosero",
  "branch": "main",
  "enabled": true,
  "localSha": "…", "remoteSha": "…",
  "updateAvailable": false,
  "lastCheckAt": "…", "lastError": null
}
```

---

## 設定（環境変数）

`npm start` の前に環境変数で変更できます（Windows PowerShell の例: `$env:PORT=8080; npm start`）。

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `3009` | 待受ポート |
| `HOST` | `0.0.0.0` | 待受アドレス（外部からの接続には 0.0.0.0） |
| `AUTO_UPDATE` | `1` | `0` にすると自動更新（適用）を無効化 |
| `UPDATE_REPO` | `HARUSINN0422/3Dosero` | 追跡する GitHub リポジトリ |
| `UPDATE_BRANCH` | `main` | 追跡するブランチ |
| `UPDATE_FIRST_DELAY_MS` | `60000` | 初回チェックまでの待ち時間（ミリ秒） |
| `UPDATE_CHECK_INTERVAL_MS` | `60000` | チェック間隔（既定1分） |
| `RESTART_AFTER_UPDATE` | `1` | 更新適用後の自動再起動（`0` で無効） |

---

## HTTP / WebSocket API（概要）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/health` | 稼働状況・ルーム数 |
| GET | `/api/update/status` | 自動更新の状態 |
| POST | `/api/update/check` | GitHub を即時チェック |
| POST | `/api/update/apply` | 更新を適用（成功すると再起動） |
| WS | `/ws` | オンライン対戦 |

WebSocket メッセージ（JSON）:

- クライアント → サーバー: `create` / `join{code}` / `move{x,y,z}` / `rematch` / `leave`
- サーバー → クライアント: `created{code,role}` / `start{role,state}` / `state{state}` / `rematch{by}` / `opponent_left` / `error{message}`

ゲーム進行は**サーバー側が権威**です。不正な手（番以外・非合法手）はサーバーが却下します。

---

## テスト

```bash
npm test
```

- `test/game.test.js` — 3Dオセロのロジック（初期配置・26方向の反転・パス/終了判定・ランダム100局の完走）
- `test/updater.test.js` — 自動更新タイマー・定期チェックの動作
- `test/ws.test.js` — サーバー統合（部屋作成/参加 → 実フル対局 → 再戦 → エラー系 → 静的配信）

---

## ディレクトリ構成

```
3Dosero/
├── server.js            # Express + WebSocket サーバー・ルーム管理
├── lib/
│   ├── game.js          # 3Dオセロのロジック（サーバーとクライアント共有）
│   ├── updater.js       # GitHub 自動更新
│   └── apply-update.js  # 手動更新 CLI（npm run update）
├── public/
│   ├── index.html       # UI（メニュー・HUD・ルール表示）
│   ├── css/style.css
│   └── js/
│       ├── main.js      # 画面・対局フロー制御
│       ├── board3d.js   # Three.js の3Dボード描画
│       └── net.js       # WebSocket クライアント
├── test/                # テスト
├── data/                # 実行時データ（更新履歴・gitignore 対象）
└── logs/                # 再起動時のログ（gitignore 対象）
```

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `EADDRINUSE` | 別プロセスが3009番を使っています。`PORT=3010 npm start` |
| 別端末から開けない | ファイアウォールでポート3009/TCPを許可、IPアドレスを確認 |
| オンラインで接続できない | サーバー側の `ws` がプロキシ等でブロックされていないか確認（WebSocket の Upgrade が必要） |
| 自動更新が失敗する | `curl` と `tar` が使えるか確認。`GET /api/update/status` の `lastError` を確認 |
| 更新後にサーバーが起動しない | `logs/server.log` を確認。`package.json` 変更時は `npm install` を再実行 |

---

## ライセンス

MIT
