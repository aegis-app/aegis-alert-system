// ==========================================
// 🚨 P2P地震情報 API の取り込み (551 / 552 / 556)
// ==========================================
// 📌 P2P 履歴 API をポーリングし、Phase 3 の変換器 (convert/p2p.ts) で
// 共通フォーマットの下書きへ変換する。本ファイルは取得 (リトライつき
// fetch) だけを担い、変換規則は変換器側に一本化する。
// API: https://api.p2pquake.net/v2/history?codes=<code>&limit=<n>
//   551 = 地震情報 / 552 = 津波予報 / 556 = 緊急地震速報（警報）
//   ※ 554 は「緊急地震速報 発表検出」のみで中身を持たないため使わない。
import { USER_AGENT, sleepMs } from "../util.js";
import { parseEews, parseQuakes, parseTsunamis } from "../convert/p2p.js";
import type { EventDraft } from "../types.js";

// 🌐 P2P 履歴 API のベース URL
const P2P_HISTORY = "https://api.p2pquake.net/v2/history";

// ------------------------------------------
// 🔄 取得 (リトライつき)
// ------------------------------------------
// ⏳ リトライ規則は Aegis Discord Bot の fetchHistory (v1.5.2) と同じ:
// ネットワークエラーと HTTP 5xx のみ最大3回 (初回+リトライ2回、
// 待機 1秒→3秒)、4xx は即失敗。タイムアウトは15秒/回。
export interface P2pFetchOptions {
  // ⏳ リトライ間隔 (ms)。要素数が試行回数-1 になる
  delaysMs?: number[];
  // ⏱️ 1回あたりのタイムアウト (ms)
  timeoutMs?: number;
}

// 🔍 HTTP ステータス由来の失敗。4xx か 5xx かでリトライ可否を判定するために使う
export class HttpError extends Error {
  constructor(
    // 🔢 HTTP ステータスコード
    readonly status: number,
    // 🌐 失敗した URL
    readonly url: string,
  ) {
    super(`HTTP ${status} (${url})`);
  }
}

// 🔄 リトライつきで JSON を取得する (P2P / Wolfx HTTP で共用)
export async function fetchJsonWithRetry(url: string, options: P2pFetchOptions = {}): Promise<unknown> {
  const delays = options.delaysMs ?? [1000, 3000];
  const timeoutMs = options.timeoutMs ?? 15000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res.json();
      throw new HttpError(res.status, url);
    } catch (err) {
      // ⏳ 4xx は即失敗。それ以外 (ネットワークエラー・5xx) はリトライする
      if (err instanceof HttpError && err.status < 500) throw err;
      lastError = err;
    }
    if (attempt < delays.length) await sleepMs(delays[attempt]);
  }
  throw lastError;
}

// 🔄 P2P 履歴 API から指定コードの履歴を取得して変換する。
// offset は履歴のページングで、ポーリング窓を広げて電文の取りこぼしを
// 減らすために使う (総点検 L6。ハブ側が満杯時に2ページ目まで広げる)
export async function fetchP2pHistory(
  code: 551 | 552 | 556,
  limit: number,
  offset = 0,
): Promise<EventDraft[]> {
  const offsetPart = offset > 0 ? `&offset=${Math.trunc(offset)}` : "";
  const data = await fetchJsonWithRetry(`${P2P_HISTORY}?codes=${code}&limit=${limit}${offsetPart}`);
  if (code === 551) return parseQuakes(data);
  if (code === 552) return parseTsunamis(data);
  return parseEews(data);
}
