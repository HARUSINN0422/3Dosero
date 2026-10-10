// GitHub 自動更新モジュール
// GitHub の指定ブランチの HEAD SHA を定期チェックし、差分があれば
// tarball (codeload.github.com) をダウンロードしてローカルのファイルを更新する。
// 適用後にサーバーはプロセスを再起動する（server.js 側で制御）。

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const GITHUB_API = 'https://api.github.com';
const SKIP_TOP_LEVEL = new Set(['node_modules', '.git', 'data', 'logs']);

function headersToCurlArgs(headers) {
  const args = [];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  return args;
}

/**
 * HTTPS GET（JSON）。fetch を使い、TLS 等で失敗した場合は curl にフォールバックする
 * （プロキシ環境などで Node のルート証明書ストアが使えない場合の保険）。
 */
function getJson(url, headers) {
  return fetch(url, { headers })
    .then(async (res) => {
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      return res.json();
    })
    .catch((err) => {
      if (err.httpStatus) throw err; // サーバーからの応答は得られた（TLS問題ではない）
      const r = spawnSync(
        'curl',
        ['-sS', '-L', '--max-time', '60', '-w', '\n%{http_code}', ...headersToCurlArgs(headers), url],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      );
      if (r.status !== 0 || r.error) {
        throw new Error(`取得失敗 (fetch: ${err.message}; curl: ${r.stderr || r.error || r.status})`);
      }
      const nl = r.stdout.lastIndexOf('\n');
      const body = nl >= 0 ? r.stdout.slice(0, nl) : r.stdout;
      const code = nl >= 0 ? Number(r.stdout.slice(nl + 1)) : NaN;
      if (code !== 200) throw new Error(`GitHub API エラー: HTTP ${code || '不明'} (${err.message})`);
      return JSON.parse(body);
    });
}

/** HTTPS GET（バイナリをファイルへ）。fetch → curl フォールバック。 */
async function downloadFile(url, dest, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    if (err.httpStatus) throw err;
    const r = spawnSync('curl', ['-sS', '-L', '--max-time', '300', '-o', dest, ...headersToCurlArgs(headers), url], {
      encoding: 'utf8',
    });
    if (r.status !== 0 || r.error) {
      throw new Error(`ダウンロード失敗 (fetch: ${err.message}; curl: ${r.stderr || r.error || r.status})`);
    }
    if (!existsSync(dest)) {
      throw new Error(`ダウンロード失敗 (fetch: ${err.message}; ファイルが作成されませんでした)`);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.repo      "owner/name" 形式（例: HARUSINN0422/3Dosero）
 * @param {string} opts.branch    追跡するブランチ
 * @param {string} opts.appRoot   アプリのルートディレクトリ
 * @param {string} opts.dataDir   実行時データの保存先（更新履歴など）
 * @param {boolean} opts.enabled  実際の適用を行うか
 * @param {Function} opts.onApplied 適用完了後に呼ぶ（サーバーの再起動など）
 */
export function createUpdater({ repo, branch, appRoot, dataDir, enabled = true, onApplied }) {
  const syncFile = path.join(dataDir, 'last_sync.json');
  const log = (...a) => console.log('[updater]', ...a);

  const status = {
    repo,
    branch,
    enabled,
    localSha: null,
    remoteSha: null,
    updateAvailable: false,
    checking: false,
    applying: false,
    lastCheckAt: null,
    lastApplyAt: null,
    lastError: null,
    applyError: null,
    applied: false,
  };

  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '3dosero-updater',
  };

  async function fetchRemoteSha() {
    const url = `${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(branch)}`;
    const json = await getJson(url, apiHeaders);
    if (!json.sha) throw new Error('GitHub API から SHA を取得できませんでした');
    return json.sha;
  }

  async function readSync() {
    try {
      return JSON.parse(await fs.readFile(syncFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeSync(obj) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(syncFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  /** 初回起動時: 今の GitHub の状態を「同期済み」として記録する（ダウンロードはしない） */
  async function ensureBaseline() {
    const existing = await readSync();
    if (existing && existing.sha) {
      status.localSha = existing.sha;
      return existing.sha;
    }
    const sha = await fetchRemoteSha();
    await writeSync({ sha, recordedAt: new Date().toISOString(), baseline: true });
    status.localSha = sha;
    log(`ベースラインを記録しました: ${sha.slice(0, 7)}`);
    return sha;
  }

  /** GitHub の HEAD をチェックして更新有無を更新する */
  async function check() {
    status.checking = true;
    status.lastCheckAt = new Date().toISOString();
    try {
      const remote = await fetchRemoteSha();
      status.remoteSha = remote;
      const sync = await readSync();
      status.localSha = sync?.sha ?? null;
      status.updateAvailable = Boolean(sync && sync.sha && sync.sha !== remote);
      status.lastError = null;
      if (status.updateAvailable) {
        log(`更新があります: ${(status.localSha || '?').slice(0, 7)} → ${remote.slice(0, 7)}`);
      } else {
        log(`最新です (${remote.slice(0, 7)})`);
      }
    } catch (err) {
      status.lastError = String(err?.message || err);
      log('チェックに失敗:', status.lastError);
    } finally {
      status.checking = false;
    }
    return { ...status };
  }

  async function downloadAndExtract(sha) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), '3dosero-upd-'));
    try {
      const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
      log(`ダウンロード中: ${url}`);
      const tarball = path.join(tmp, 'update.tar.gz');
      await downloadFile(url, tarball, { 'User-Agent': '3dosero-updater' });

      const extractDir = path.join(tmp, 'extracted');
      await fs.mkdir(extractDir, { recursive: true });
      const r = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`tar 展開に失敗: ${r.stderr || r.error}`);
      const entries = await fs.readdir(extractDir);
      if (entries.length !== 1) throw new Error('アーカイブの形式が想定外です');
      const srcRoot = path.join(extractDir, entries[0]);

      const pkgBefore = await fs
        .readFile(path.join(appRoot, 'package.json'), 'utf8')
        .catch(() => null);
      const pkgAfter = await fs.readFile(path.join(srcRoot, 'package.json'), 'utf8').catch(() => null);

      await fs.cp(srcRoot, appRoot, {
        recursive: true,
        force: true,
        filter: (src) => {
          const rel = path.relative(srcRoot, src);
          if (!rel) return true; // ルート自身
          const first = rel.split(path.sep)[0];
          return !SKIP_TOP_LEVEL.has(first);
        },
      });
      log('ファイルを更新しました');

      if (pkgBefore && pkgAfter && pkgBefore !== pkgAfter) {
        log('package.json の変更を検出 — npm install を実行します');
        const ins = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300_000,
        });
        if (ins.status === 0) {
          log('npm install が完了しました');
        } else {
          log('npm install に失敗しました（既存の node_modules で続行します）:', String(ins.stderr || '').slice(0, 400));
        }
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 更新を適用する。
   * @returns {Promise<{applied: boolean, reason?: string}>}
   */
  async function apply() {
    if (status.applying) return { applied: false, reason: 'already_applying' };
    status.applying = true;
    status.applyError = null;
    status.applied = false;
    try {
      if (!enabled) {
        status.applying = false;
        return { applied: false, reason: 'disabled' };
      }
      let sync = await readSync();
      if (!sync || !sync.sha) {
        await ensureBaseline();
        sync = await readSync();
      }
      const remote = status.remoteSha || (await fetchRemoteSha());
      status.remoteSha = remote;
      status.localSha = sync?.sha ?? null;
      if (sync?.sha === remote) {
        status.updateAvailable = false;
        status.applying = false;
        return { applied: false, reason: 'already_up_to_date' };
      }

      log(`更新を適用します: ${(sync?.sha || '?').slice(0, 7)} → ${remote.slice(0, 7)}`);
      await downloadAndExtract(remote);
      await writeSync({
        sha: remote,
        appliedAt: new Date().toISOString(),
        previousSha: sync?.sha ?? null,
      });
      status.localSha = remote;
      status.updateAvailable = false;
      status.lastApplyAt = new Date().toISOString();
      status.applied = true;
      log('更新の適用が完了しました。再起動します。');
      if (typeof onApplied === 'function') {
        try {
          onApplied({ sha: remote });
        } catch (err) {
          log('再起動ハンドラでエラー:', String(err?.message || err));
        }
      }
      return { applied: true, sha: remote };
    } catch (err) {
      status.applyError = String(err?.message || err);
      log('適用に失敗:', status.applyError);
      throw err;
    } finally {
      status.applying = false;
    }
  }

  const api = {
    status,
    ensureBaseline,
    check,
    apply,
    startPeriodic,
    getSyncFile: () => syncFile,
  };

  /** 定期チェックを開始する。届いたら apply も自動で行う。 */
  function startPeriodic({ firstDelayMs, intervalMs }) {
    let stopped = false;
    let timer = null;

    const runCheck = async () => {
      if (status.checking || status.applying) return;
      try {
        await api.check();
        if (status.updateAvailable) {
          await api.apply();
        }
      } catch {
        /* ignore */
      }
    };

    const first = setTimeout(() => {
      if (stopped) return;
      runCheck();
      timer = setInterval(() => {
        if (stopped) return;
        runCheck();
      }, intervalMs);
      timer.unref?.();
    }, firstDelayMs ?? intervalMs);
    first.unref?.();

    return () => {
      stopped = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }

  return api;
}
