// ==========================================
// 🧰 共通ユーティリティ
// ==========================================
// 📌 ハブ核 (ストア・配信) と変換モジュールが使う時刻・数値・座標の
// 共通処理。変換規則のうち経路をまたいで一致させなければならないもの
// (同一視キーの生成など) はここに置き、各変換器から共有する。
// ⚠️ 同一視キーの規則は Aegis ファミリー各実装 (Discord Bot 等) と
// 互換でなければならない。変えるときは各実装と食い違わないよう注意する

// 📡 取得リクエストの User-Agent (提供元への名乗り)
export const USER_AGENT = "aegis-alert-system/0.1 (+https://github.com/aegis-app)";

// 🔢 数値に変換できる値だけを取り出し、それ以外は null にする
export function numOrNull(v: unknown): number | null {
  // ⚙️ 空文字は未設定として扱う (Number("") === 0 で 0 に化けるのを防ぐ)
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// 🌍 深さの正規化: 負値は震源未確定時の不明センチネルなので null にする。
// 0 は「ごく浅い」を表す正当な値なので保持する
export function depthOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? n : null;
}

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

// 🌍 EEW・地震の同一視キー用の震央座標の丸め: 小数1桁に丸め、震源名の
// 表記変更があってもキーが崩れないようにする
export function roundedCoordKey(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return "";
  return `@${lat.toFixed(1)},${lon.toFixed(1)}`;
}

// 🚨 EEW の同一視キー (baseKey) を作る。
// JMA のイベント ID (P2P 556 の issue.eventId と Wolfx の EventID で
// 同値) が取れる場合はそれを同一性の軸にする: 「発生時刻 (秒精度) +
// 座標」の規則は、発生時刻が経路・報ごとに1秒ずれるだけで同一イベント
// が別キーに分裂していた実例があるため。eventId が無い場合のみ
// 発生時刻+座標 (座標が無ければ震源名) へフォールバックする
export function eewBaseKey(
  eventId: string | null,
  originTime: string,
  coordKey: string,
  hypoName: string,
): string {
  if (eventId) return `eew-id:${eventId}`;
  return coordKey ? `eew-${originTime}${coordKey}` : `eew-${originTime}-${hypoName}`;
}

// 📍 2点間の距離 (km、ヒュベニの公式)。地震の複数報グルーピングの補助に使う
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371.0;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
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
