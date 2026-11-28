// ==========================================
// 🚀 A.A.S (Aegis Alert System) エントリポイント
// ==========================================
// 📌 ハブ核 (EventStore / REST / SSE / マスターデータ) を配線して
// 起動する。設定は環境変数 (config.ts)。配信は通常リスナー (私設
// ネットワーク内) が本線で、A2S_PUBLIC_PORT が設定された場合のみ
// 公開用リスナー (127.0.0.1、中継先) も起動する。
// 変換とマスターデータは Phase 3 で配線済み。取り込み (Phase 2) は
// 後続フェーズで配線する。
// 終了時はサーバーを閉じ、保持イベントを保存してから終わる。
import { loadConfig } from "./config.js";
import { AccessLogger } from "./access-log.js";
import { MasterDataService } from "./master.js";
import { registerMasterData } from "./master-data.js";
import { createA2sServer, createPublicA2sServer, type A2sServer } from "./server.js";
import { EventStore } from "./store.js";
import { EVENT_KINDS } from "./types.js";
import { logInfo, logWarn } from "./util.js";

// 🏷️ バージョン (package.json の version と一致させる)
const VERSION = "0.1.0";

function main(): void {
  const config = loadConfig();

  const store = new EventStore({ filePath: config.dataFile });
  store.load();
  const counts = store.counts();
  // 📊 復元件数は種別を列挙せず EVENT_KINDS から汎用に組み立てる
  // (種別追加のたびにログ側を直さないため)
  logInfo(
    `イベントを復元しました: ${counts.total} 件 (${EVENT_KINDS.map((k) => `${k} ${counts[k]}`).join(" / ")})`,
  );

  const accessLog = new AccessLogger(config.accessLogFile);

  // 📚 マスターデータ。静的データセット (data/master/) を読み込んで
  // 登録し、AMeDAS は実行時取得の供給者として登録して取得を開始する
  const master = new MasterDataService();
  const { amedas } = registerMasterData(master);
  amedas.start();

  // 📡 配信サーバー。公開リスナーとは SSE ハブを共有し、どちらの
  // 接続にも配信が届くようにする。
  // 📊 経路別の健康状態は取り込み (Phase 2) が提供する。Phase 1 では
  // 取り込みが無いため空を返す
  const sharedDeps = {
    store,
    token: config.token,
    clientTokens: config.clientTokens,
    // 🚧 公開 EEW ゲート: 許可クライアント名と DMDSS キーの有無を
    // サーバーへ渡す (キーの値自体は渡さない)
    publicEewClients: new Set(config.publicEewClients),
    dmdssConfigured: config.dmdssApiKey !== undefined,
    // 🌐 CORS 許可オリジン。ブラウザ (bosai) から公開 API を読める
    // のはこの一覧のオリジンだけ
    corsOrigins: config.corsOrigins,
    master,
    version: VERSION,
    statusProvider: (): Record<string, unknown> => ({}),
    accessLog,
  };
  const a2s = createA2sServer(sharedDeps);
  const publicA2s: A2sServer | undefined =
    config.publicPort !== undefined
      ? createPublicA2sServer({ ...sharedDeps, sseHub: a2s.sseHub })
      : undefined;

  a2s.server.listen(config.port, config.host, () => {
    logInfo(
      `A.A.S v${VERSION} を起動しました: http://${config.host}:${config.port} (GET /health, /v1/status, /v1/events, /v1/stream, /v1/master)`,
    );
    if (!config.token && config.clientTokens.size === 0) {
      // ⚠️ トークン未設定は開発用の無認証モード。公開環境では必ず設定する
      logWarn("A2S_TOKEN / A2S_CLIENT_TOKENS が未設定のため無認証で動作しています (開発用)。本番では必ず設定してください");
    }
    if (config.clientTokens.size > 0) {
      // 🔑 登録済みの利用者名だけを出す (トークンの値は出さない)
      logInfo(`利用者別トークン: ${[...config.clientTokens.keys()].join(", ")}`);
    }
    if (config.publicEewClients.length > 0) {
      // 🚧 公開 EEW ゲートの状態を起動時に明示する。許可リストが
      // あっても DMDSS キーが無ければ配信は有効にならない
      if (config.dmdssApiKey !== undefined) {
        logInfo(`公開 EEW 配信の許可クライアント: ${config.publicEewClients.join(", ")}`);
      } else {
        logWarn("A2S_PUBLIC_EEW_CLIENTS が設定されていますが、A2S_DMDSS_API_KEY が未設定のため公開 EEW 配信は無効です");
      }
    }
    if (config.riverIntervalMs === 0) {
      logInfo("river ingest: disabled (A2S_RIVER_INTERVAL_MS=0)");
    }
  });

  if (publicA2s && config.publicPort !== undefined) {
    const publicPort = config.publicPort;
    publicA2s.server.listen(publicPort, "127.0.0.1", () => {
      logInfo(`公開用リスナーを起動しました: http://127.0.0.1:${publicPort} (利用者別トークンのみ、読み取り系のみ)`);
      if (config.clientTokens.size === 0) {
        logWarn("A2S_CLIENT_TOKENS が未設定のため、公開用リスナーは全リクエストを拒否します");
      }
    });
  }

  // 🛑 終了処理: AMeDAS の日次更新を止め、サーバーを閉じる → 保持イベントを保存する
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    amedas.stop();
    logInfo(`${signal} を受信したため終了します`);
    const closers = publicA2s ? [a2s.close(), publicA2s.close()] : [a2s.close()];
    void Promise.allSettled(closers).finally(() => {
      store.saveNow();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
