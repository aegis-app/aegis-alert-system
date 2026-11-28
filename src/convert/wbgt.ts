// ==========================================
// 🔀 熱中症警戒アラートの変換 (環境省 WBGT)
// ==========================================
// 📌 環境省「熱中症予防情報サイト」の暑さ指数 (WBGT) 電子情報提供
// サービスが公開するアラート発表情報 CSV を共通フォーマットへ変換する
// (登録不要・公式)。取得は Phase 2 の領分で、ここは URL の組み立てと
// 純粋な変換だけを行う。
// 📌 本データは環境省熱中症予防情報サイトからの提供情報を利用して
// いる。CSV は参考情報という位置づけで、正式発表は環境省のサイト/
// 報道発表が正である。
// 🔍 形式 (2026/08/15 17時発表分の実ファイルで確認):
// - URL: https://www.wbgt.env.go.jp/alert/dl/<年>/alert_<YYYYMMDD>_<HH>.csv
//   (HH は発表タイミング 05 / 10 / 14 / 17)
// - 文字コードは UTF-8 (ファイル冒頭の "Encoding,UTF-8" 宣言どおり)
// - 先頭はキー,値 形式のメタ行 (ReportDate / ReportTime / TargetDate1 /
//   TargetDate2 等)、続いて府県予報区ごとの表 (府県予報区名 /
//   府県予報区等コード / 都道府県名 / TargetDate1フラグ /
//   TargetDate2フラグ / 地点別の日最高WBGT 列×発表回数分)
// - フラグ: 0=発表なし / 1=熱中症警戒アラート / 2=熱中症特別警戒
//   アラートの判定 / 3=熱中症特別警戒アラート / 9=発表時間外
// 📌 運用は季節限定 (4月第4水曜〜10月下旬) で、期間外は当日ファイル
// 自体が存在しない。取得できない場合は「発表なし (全解除)」ではなく
// 「状態不明」として前回状態を保持する (ストアへ流す側の契約)
import { numOrNull } from "../util.js";
import type { HeatDraft } from "../types.js";

// 🌐 アラート発表情報 CSV の配置ベース
export const WBGT_ALERT_BASE = "https://www.wbgt.env.go.jp/alert/dl";

// 🕐 発表タイミング (新しい順に試すため降順)
const PUBLISH_HOURS = ["17", "14", "10", "05"] as const;

// 📌 レベルの表示名。2 は「特別警戒アラートの判定 (発表の前段階)」
export function heatLevelName(level: number): string {
  switch (level) {
    case 3: return "熱中症特別警戒アラート";
    case 2: return "熱中症特別警戒アラート判定";
    case 1: return "熱中症警戒アラート";
    default: return "発表なし";
  }
}

// 📌 フラグの正規化: 9 (発表時間外) は「その対象日については発表の
// 対象外」であり、アラートの強さではないため 0 として扱う
function normalizeFlag(raw: unknown): number {
  const n = numOrNull(raw);
  if (n === null || n === 9) return 0;
  return Math.trunc(n);
}

// 🌐 CSV の URL を作る (日付は JST の年月日)
export function buildWbgtAlertUrl(year: number, yyyymmdd: string, hour: string): string {
  return `${WBGT_ALERT_BASE}/${year}/alert_${yyyymmdd}_${hour}.csv`;
}

// 🕐 JST の年月日文字列 (YYYYMMDD) を作る (日本は夏時間が無いため
// UTC+9 の固定オフセットで足りる)
function jstYyyymmdd(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// 🌐 候補ファイルの URL 一覧: 当日分の新しい順 → 前日分の新しい順。
// 発表タイミング (5時/10時/14時/17時) のうち、まだ来ていない回は
// 存在しないため 404 になるが、順に試して最初に取得できたものを
// 正とする (候補は最大8件)
export function wbgtCandidateUrls(now: Date = new Date()): string[] {
  const urls: string[] = [];
  for (const dayOffset of [0, -1]) {
    const d = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const ymd = jstYyyymmdd(d);
    const year = Number(ymd.slice(0, 4));
    for (const hour of PUBLISH_HOURS) urls.push(buildWbgtAlertUrl(year, ymd, hour));
  }
  return urls;
}

// ------------------------------------------
// 🌡️ CSV の変換
// ------------------------------------------
// 📝 メタ行 (キー,値) を読む。値はカンマを含みうるため、最初のカンマ
// でだけ割り、末尾の区切りカンマ列は落とす
function parseMeta(lines: string[]): Map<string, string> {
  const meta = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(",");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || key === "府県予報区") break; // 表の開始行でメタは終わる
    meta.set(key, line.slice(idx + 1).replace(/,+$/, "").trim());
  }
  return meta;
}

// 🌡️ 地点別 WBGT 列 ("地点名:値/地点名:値/...") 群から最大値を取る
function maxWbgtOf(cells: string[]): { value: number | null; station: string | null } {
  let value: number | null = null;
  let station: string | null = null;
  for (const cell of cells) {
    for (const part of cell.split("/")) {
      const idx = part.lastIndexOf(":");
      if (idx < 0) continue;
      const v = numOrNull(part.slice(idx + 1));
      if (v === null) continue;
      if (value === null || v > value) {
        value = v;
        station = part.slice(0, idx).trim() || null;
      }
    }
  }
  return { value, station };
}

// 🌡️ アラート発表情報 CSV を熱中症アラートの下書きに変換する。
// フラグが両対象日とも 0 の区域は下書きを作らない (有効集合に
// 含めない。warning の「発表中ゼロの区域は作らない」と同じ規則)
export function parseWbgtAlertCsv(text: string): HeatDraft[] {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const meta = parseMeta(lines);
  const reportDate = meta.get("ReportDate") ?? "";
  const reportTime = meta.get("ReportTime") ?? "";
  const targetDate1 = meta.get("TargetDate1") ?? "";
  const targetDate2 = meta.get("TargetDate2") ?? "";
  // 🕐 発表日時の ISO 表記 (JST)。読めない場合は空文字にせず、ファイル
  // 名の日付が別途 reportDate に残るため、代表時刻は reportDate 由来で作る
  const isoDate = reportDate.replaceAll("/", "-");
  const reportDatetime =
    isoDate && reportTime ? `${isoDate}T${reportTime}+09:00` : isoDate ? `${isoDate}T00:00:00+09:00` : "";

  const headerIdx = lines.findIndex((l) => l.startsWith("府県予報区,"));
  if (headerIdx < 0) return [];
  const out: HeatDraft[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    // 📌 列: 0=府県予報区名 / 3=府県予報区等コード / 4=都道府県名 /
    // 6=TargetDate1フラグ / 7=TargetDate2フラグ / 8〜=地点別WBGT
    const areaName = (cells[0] ?? "").trim();
    const areaCode = (cells[3] ?? "").trim();
    if (!areaName || !areaCode) continue;
    const flag1 = normalizeFlag(cells[6]);
    const flag2 = normalizeFlag(cells[7]);
    const level = Math.max(flag1, flag2);
    if (level <= 0) continue;
    const max = maxWbgtOf(cells.slice(8));
    out.push({
      kind: "heat",
      key: `heat:${areaCode}`,
      areaCode,
      areaName,
      prefName: (cells[4] ?? "").trim(),
      level,
      levelName: heatLevelName(level),
      target1: { date: targetDate1, flag: flag1 },
      target2: { date: targetDate2, flag: flag2 },
      maxWbgt: max.value,
      maxWbgtStation: max.station,
      reportDate,
      reportTime,
      reportDatetime,
      time: reportDatetime,
      released: false,
    });
  }
  return out;
}
