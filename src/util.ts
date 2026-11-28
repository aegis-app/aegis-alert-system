// ==========================================
// 🧰 共通ユーティリティ
// ==========================================
// 📌 ハブ核 (ストア・配信) が使う時刻・ログの共通処理。取り込み側の
// 変換規則 (同一視キーの生成など) は Phase 3 で変換モジュールと
// ともに追加する。

// 🕐 P2P の時刻表記 ("2026/11/19 06:41:00"、JST) を Date に変換する
export function parseP2pTime(s: string): Date | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? "");
  if (!m) return null;
  // 🕐 P2P の時刻は JST。ローカル時刻として解釈せず、UTC+9 として構築する
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+09:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 🕐 Date を P2P 表記 (JST) へ整形する
export function formatP2pTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

// ⏳ 指定ミリ秒だけ待つ
export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// 📝 ログ出力 (ISO 時刻つき、標準出力/標準エラーへ)
export function logInfo(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
export function logWarn(msg: string): void {
  console.warn(`[${new Date().toISOString()}] ⚠️ ${msg}`);
}
