// ==========================================
// 🚀 A.A.S (Aegis Alert System) エントリポイント
// ==========================================
// 📌 再実装の土台 (Phase 1)。現時点では設定を読み取り、起動状態を
// ログへ出すだけの最小ブート。ハブ核 (EventStore / SSE / REST) と
// 取り込みは後続フェーズで順に実装する (計画は DESIGN.md)。
import { loadConfig } from "./config.js";

// 🏷️ バージョン (package.json の version と一致させる)
const VERSION = "0.1.0";

function main(): void {
  const config = loadConfig();

  // 📣 起動ログ。秘密情報 (トークンや API キーの値) は絶対に出力しない
  console.log(`A.A.S (Aegis Alert System) v${VERSION}`);
  console.log(`owner listener: http://${config.host}:${config.port} (not started yet — Phase 1 scaffold)`);
  if (config.token === undefined) {
    // ⚠️ トークン未設定は開発用の無認証モード。公開環境では必ず設定する
    console.warn("warning: A2S_TOKEN is not set — running without authentication (development only)");
  }
  console.log(
    config.publicPort !== undefined
      ? `public listener: http://127.0.0.1:${config.publicPort} (named client tokens only)`
      : "public listener: disabled (A2S_PUBLIC_PORT is not set)",
  );
  console.log(
    config.dmdssApiKey !== undefined
      ? "DMDSS ingest: configured"
      : "DMDSS ingest: disabled (A2S_DMDSS_API_KEY is not set)",
  );
  console.log(
    config.riverIntervalMs === 0
      ? "river ingest: disabled (A2S_RIVER_INTERVAL_MS=0)"
      : `river ingest: interval ${config.riverIntervalMs} ms`,
  );
}

main();
