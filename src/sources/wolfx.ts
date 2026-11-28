// ==========================================
// 🚨 Wolfx Open API の取り込み (EEW の HTTP フォールバック)
// ==========================================
// 📌 Wolfx `jma_eew` は緊急地震速報（予報）の再配信で、WebSocket 経路
// (wolfx-ws.ts) が本線。こちらは WS 切断中のみハブが使う HTTP
// フォールバックで、変換は convert/wolfx.ts を WS 経路と共用する。
// API: https://api.wolfx.jp/jma_eew.json (最新1件のみ)
import { parseWolfxEew, type WolfxParseOptions } from "../convert/wolfx.js";
import { fetchJsonWithRetry } from "./p2p.js";
import type { EventDraft } from "../types.js";

// 🌐 Wolfx EEW (HTTP) の URL
export const WOLFX_EEW_URL = "https://api.wolfx.jp/jma_eew.json";

// 🔄 jma_eew.json の生 JSON を取得する。リトライ作法は P2P と同じだが、
// タイムアウトは補完経路のため短めの10秒にする (Bot と同じ)
export async function fetchWolfxEewJson(): Promise<unknown> {
  return fetchJsonWithRetry(WOLFX_EEW_URL, { timeoutMs: 10000 });
}

// 🔄 Wolfx から最新の EEW を取得する。訓練・鮮度切れ等で使えない場合は
// null を返し、取得自体が失敗した場合は例外を投げる
export async function fetchWolfxEew(options: WolfxParseOptions = {}): Promise<EventDraft | null> {
  return parseWolfxEew(await fetchWolfxEewJson(), options);
}
