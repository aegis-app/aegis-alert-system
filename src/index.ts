// ==========================================
// 🚀 A.A.S (Aegis Alert System) エントリポイント
// ==========================================
// 📌 ハブ核 (EventStore / REST / SSE / マスターデータ) と取り込み
// (ハブ) を配線して起動する。設定は環境変数 (config.ts)。配信は
// 通常リスナー (私設ネットワーク内) が本線で、A2S_PUBLIC_PORT が
// 設定された場合のみ公開用リスナー (127.0.0.1、中継先) も起動する。
// 取り込みの新規・更新イベントは SSE ハブ経由で両リスナーへ届く。
// 終了時は取り込みを止め、サーバーを閉じ、保持イベントを保存して
// から終わる。
import { loadConfig } from "./config.js";
import { AccessLogger } from "./access-log.js";
import { Hub } from "./hub.js";
import { MasterDataService } from "./master.js";
import { registerMasterData } from "./master-data.js";
import { createA2sServer, createPublicA2sServer, type A2sServer } from "./server.js";
import { EventStore } from "./store.js";
import { EVENT_KINDS, type A2sEvent } from "./types.js";
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

  // 🎛️ 取り込みハブ。配信先 (SSE の broadcast) はサーバー生成後に
  // 差し込む (ハブとサーバーの相互参照を避けるため、受け渡し口を
  // 先に用意して後から差し替える)
  let broadcast: (ev: A2sEvent) => void = () => undefined;
  const hub = new Hub(store, {
    p2pEewIntervalMs: config.p2pEewIntervalMs,
    p2pQuakeIntervalMs: config.p2pQuakeIntervalMs,
    p2pTsunamiIntervalMs: config.p2pTsunamiIntervalMs,
    wolfxHttpIntervalMs: config.wolfxHttpIntervalMs,
    jmaWarningIntervalMs: config.jmaWarningIntervalMs,
    jmaTyphoonIntervalMs: config.jmaTyphoonIntervalMs,
    jmaXmlIntervalMs: config.jmaXmlIntervalMs,
    riverIntervalMs: config.riverIntervalMs,
    riverConcurrency: config.riverConcurrency,
    riverSystemDelayMs: config.riverSystemDelayMs,
    heatIntervalMs: config.heatIntervalMs,
    jmaXmlSeenFile: config.jmaXmlSeenFile,
    dmdssApiKey: config.dmdssApiKey,
    dmdssClassifications: config.dmdssClassifications,
    onEvent: (ev) => broadcast(ev),
  });

  // 📡 配信サーバー。公開リスナーとは SSE ハブを共有し、どちらの
  // 接続にも配信が届くようにする。
  // 📊 経路別の健康状態はハブが保持し、/v1/status の sources に載る
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
    statusProvider: () => hub.status(),
    accessLog,
  };
  const a2s = createA2sServer(sharedDeps);
  // 📣 ハブの配信先を本線サーバーの SSE ハブへ差し替える (公開
  // リスナーは同じハブを共有するため、そちらにも届く)
  broadcast = (ev) => a2s.broadcast(ev);
  hub.start();
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

  // 🛑 終了処理: 取り込みと AMeDAS の日次更新を止め、サーバーを閉じる
  // → 保持イベントを保存する
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    hub.stop();
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
