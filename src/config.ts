// ==========================================
// ⚙️ 設定 (環境変数)
// ==========================================
// 📌 A.A.S の全設定は環境変数から読み取る (一覧は .env.example と
// DESIGN.md の「環境変数」)。既定値はすべて localhost 前提の安全な値で、
// 不正な値は黙って許可範囲を広げず、既定値か「無効」に倒す。
import { dirname, join, resolve } from "node:path";

// 📦 型付き設定一式
export interface AasConfig {
  // 🌐 バインドするホスト。既定は 127.0.0.1 (同一マシン内のみ)
  host: string;
  // 🌐 owner リスナーのポート。既定 8730
  port: number;
  // 🔑 共有トークン (owner)。未設定なら無認証 (開発用) になり、起動時に警告する
  token?: string;
  // 🔑 利用者別トークン (名前 → トークン)。公開リスナーで使えるのは
  // こちらのみで、owner トークンは公開側では拒否する
  clientTokens: Map<string, string>;
  // 🚧 公開リスナーで EEW を配信してよいクライアント名の一覧。
  // EEW は供給元の二次利用制限のため原則オフで、この一覧に名前があり、
  // かつ供給元が DMDSS (dmdssApiKey 設定済み) のときにだけ届ける
  publicEewClients: string[];
  // 🌐 公開用リスナーのポート (127.0.0.1 バインド)。未設定なら公開
  // リスナーは起動しない
  publicPort?: number;
  // 🌐 CORS を許可するオリジンの一覧。不正な値だけの場合は既定値に倒す
  corsOrigins: string[];
  // 💾 イベントの永続化先
  dataFile: string;
  // 📝 アクセスログの出力先
  accessLogFile: string;
  // ⏱️ P2P (EEW / 地震 / 津波) のポーリング間隔 (ms)
  p2pEewIntervalMs: number;
  p2pQuakeIntervalMs: number;
  p2pTsunamiIntervalMs: number;
  // ⏱️ Wolfx HTTP フォールバックの間隔 (ms)
  wolfxHttpIntervalMs: number;
  // ⏱️ 気象庁 警報・注意報 (既定60秒) / 台風 (既定300秒) の間隔 (ms)
  jmaWarningIntervalMs: number;
  jmaTyphoonIntervalMs: number;
  // ⏱️ 気象庁防災情報XML フィードのポーリング間隔 (ms)。既定60秒
  jmaXmlIntervalMs: number;
  // ⏱️ 川の防災情報 (河川観測値・ダム) のポーリング間隔 (ms)。既定600000。
  // ⚠️ 0 を指定すると河川取り込み自体を無効化する。現行本番では巡回負荷
  // 対策のため 0 (無効) で運用中であり、恒久対策が入るまで有効化しない
  riverIntervalMs: number;
  // 🔄 川の防災情報の巡回の同時取得数と、1水系ごとに空ける間隔 (ms)。
  // 巡回の負荷を抑える速度制限
  riverConcurrency: number;
  riverSystemDelayMs: number;
  // ⏱️ 熱中症警戒アラート (環境省 WBGT) のポーリング間隔 (ms)。既定1800000
  heatIntervalMs: number;
  // 💾 気象庁防災情報XML の既読ファイル。dataFile と同じディレクトリに
  // 置き、パスは dataFile から導出する
  jmaXmlSeenFile: string;
  // 🔑 DMDSS (dmdata.jp) の API キー。未設定なら DMDSS 取り込みは完全に無効
  dmdssApiKey?: string;
  // 📋 DMDSS で購読する区分の一覧。空なら組み込みの既定
  // (eew.forecast + telegram.earthquake) を使う。契約区分に合わせて絞る
  dmdssClassifications: string[];
}

// 🔢 数値の環境変数を安全に読む (不正値・0以下は既定値)
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

// 🔢 0 も有効な値として読む数値環境変数 (0 に「無効化」の意味を持たせる
// 設定用。不正値と負値は既定値)
function intEnvAllowZero(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

// 🔑 利用者別トークンを読む。形式は "name1:token1,name2:token2"。
// 名前はアクセスログの識別子になるため、owner / anonymous は予約名として
// 受け付けない。不正な要素 (区切りなし・名前やトークンが空) は読み飛ばす
export function parseClientTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const token = part.slice(idx + 1).trim();
    if (!name || !token) continue;
    if (name === "owner" || name === "anonymous") continue;
    out.set(name, token);
  }
  return out;
}

// 📋 カンマ区切りの名前一覧を読む (前後の空白は除き、重複は落とす)。
// A2S_PUBLIC_EEW_CLIENTS や DMDSS の区分割当のような「名前だけ」の一覧用
export function parseNameList(raw: string | undefined): string[] {
  const out: string[] = [];
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// 🌐 CORS 許可オリジンの既定値 (bosai の公開サイト)
export const DEFAULT_CORS_ORIGINS: readonly string[] = ["https://bosai.vercel.app"];

// 🌐 CORS 許可オリジンを読む。各要素は http/https のオリジン
// (スキーム + ホスト [+ ポート]) に正規化し、パスやクエリを含む値・
// 解釈できない値は読み飛ばす。1件も残らなければ既定値に倒す
// (許可先を黙って広げない)
export function parseCorsOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  if (raw) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (!value) continue;
      let origin: string;
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        origin = url.origin;
      } catch {
        continue;
      }
      if (origin && origin !== "null" && !out.includes(origin)) out.push(origin);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_CORS_ORIGINS];
}

// 🔢 ポート番号を読む。1〜65535 の整数でなければ undefined
// (公開リスナーの「未設定 = 起動しない」を表す)
function portEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

// ⚙️ 環境変数から設定を組み立てる
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AasConfig {
  const token = env.A2S_TOKEN?.trim();
  const dataFile = resolve(env.A2S_DATA_FILE?.trim() || "data/events.json");
  return {
    host: env.A2S_HOST?.trim() || "127.0.0.1",
    port: portEnv(env.A2S_PORT) ?? 8730,
    token: token ? token : undefined,
    clientTokens: parseClientTokens(env.A2S_CLIENT_TOKENS),
    publicEewClients: parseNameList(env.A2S_PUBLIC_EEW_CLIENTS),
    publicPort: portEnv(env.A2S_PUBLIC_PORT),
    corsOrigins: parseCorsOrigins(env.A2S_CORS_ORIGINS),
    dataFile,
    accessLogFile: resolve(env.A2S_ACCESS_LOG_FILE?.trim() || "data/access.log"),
    p2pEewIntervalMs: intEnv(env, "A2S_P2P_EEW_INTERVAL_MS", 15000),
    p2pQuakeIntervalMs: intEnv(env, "A2S_P2P_QUAKE_INTERVAL_MS", 30000),
    p2pTsunamiIntervalMs: intEnv(env, "A2S_P2P_TSUNAMI_INTERVAL_MS", 30000),
    wolfxHttpIntervalMs: intEnv(env, "A2S_WOLFX_HTTP_INTERVAL_MS", 20000),
    jmaWarningIntervalMs: intEnv(env, "A2S_JMA_WARNING_INTERVAL_MS", 60000),
    jmaTyphoonIntervalMs: intEnv(env, "A2S_JMA_TYPHOON_INTERVAL_MS", 300000),
    jmaXmlIntervalMs: intEnv(env, "A2S_JMA_XML_INTERVAL_MS", 60000),
    riverIntervalMs: intEnvAllowZero(env, "A2S_RIVER_INTERVAL_MS", 600000),
    riverConcurrency: intEnv(env, "A2S_RIVER_CONCURRENCY", 8),
    riverSystemDelayMs: intEnvAllowZero(env, "A2S_RIVER_SYSTEM_DELAY_MS", 0),
    heatIntervalMs: intEnv(env, "A2S_HEAT_INTERVAL_MS", 1800000),
    jmaXmlSeenFile: join(dirname(dataFile), "jma-xml-seen.json"),
    dmdssApiKey: env.A2S_DMDSS_API_KEY?.trim() || undefined,
    dmdssClassifications: parseNameList(env.A2S_DMDSS_CLASSIFICATIONS),
  };
}
