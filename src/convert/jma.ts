// ==========================================
// 🔀 気象庁 (警報・注意報 / 台風) の変換
// ==========================================
// 📌 気象庁 bosai の JSON を共通フォーマットへ変換する。規則は Aegis
// ファミリー各実装 (Discord Bot の jma.ts) と一致させる。
//   警報: warning/<officeCode>.json (官署ごと)
//   台風: targetTc.json
//   区域名: area.json の class10s (コード → 区域名の対応表)
// 取得と区域名リゾルバのキャッシュ管理は Phase 2 の領分で、ここは
// 純粋な変換だけを行う (区域名は解決関数を引数で受ける)。
import type { TyphoonDraft, WarningDraft, WarningEntry } from "../types.js";

// ------------------------------------------
// 📍 官署コード表
// ------------------------------------------
// ⚠️ 都道府県名 → 気象庁の警報 JSON コード (warning/<code>.json) の静的表。
// 大半の都府県は「XX0000」の1コードだが、北海道は8地方、鹿児島県は
// 本土・奄美の2コード、沖縄県は4地方に分かれる (気象庁 area.json の
// offices で確認した値)。キーは都道府県の正式名 (都/府/県/道つき)
export const PREFECTURE_WARNING_CODES: Record<string, string[]> = {
  "北海道": ["011000", "012000", "013000", "014030", "014100", "015000", "016000", "017000"],
  "青森県": ["020000"],
  "岩手県": ["030000"],
  "宮城県": ["040000"],
  "秋田県": ["050000"],
  "山形県": ["060000"],
  "福島県": ["070000"],
  "茨城県": ["080000"],
  "栃木県": ["090000"],
  "群馬県": ["100000"],
  "埼玉県": ["110000"],
  "千葉県": ["120000"],
  "東京都": ["130000"],
  "神奈川県": ["140000"],
  "新潟県": ["150000"],
  "富山県": ["160000"],
  "石川県": ["170000"],
  "福井県": ["180000"],
  "山梨県": ["190000"],
  "長野県": ["200000"],
  "岐阜県": ["210000"],
  "静岡県": ["220000"],
  "愛知県": ["230000"],
  "三重県": ["240000"],
  "滋賀県": ["250000"],
  "京都府": ["260000"],
  "大阪府": ["270000"],
  "兵庫県": ["280000"],
  "奈良県": ["290000"],
  "和歌山県": ["300000"],
  "鳥取県": ["310000"],
  "島根県": ["320000"],
  "岡山県": ["330000"],
  "広島県": ["340000"],
  "山口県": ["350000"],
  "徳島県": ["360000"],
  "香川県": ["370000"],
  "愛媛県": ["380000"],
  "高知県": ["390000"],
  "福岡県": ["400000"],
  "佐賀県": ["410000"],
  "長崎県": ["420000"],
  "熊本県": ["430000"],
  "大分県": ["440000"],
  "宮崎県": ["450000"],
  "鹿児島県": ["460100", "460040"],
  "沖縄県": ["471000", "472000", "473000", "474000"],
};

// 🏢 全官署コード (全58コード。表の記載順)
export const ALL_OFFICE_CODES: readonly string[] = Object.values(PREFECTURE_WARNING_CODES).flat();

// 🏢 官署コード → 都道府県名の逆引き
export const OFFICE_PREF_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(PREFECTURE_WARNING_CODES).flatMap(([pref, codes]) =>
    codes.map((code) => [code, pref] as const),
  ),
);

// ------------------------------------------
// ⚠️ 警報コード表・重要度
// ------------------------------------------
// ⚠️ 気象庁 警報コード (主要なもの)
export const JMA_WARNING_CODES: Record<string, string> = {
  "02": "暴風雪警報", "03": "大雨警報", "04": "洪水警報", "05": "暴風警報",
  "06": "大雪警報", "07": "波浪警報", "08": "高潮警報",
  "10": "大雨注意報", "12": "大雪注意報", "13": "風雪注意報", "14": "雷注意報",
  "15": "強風注意報", "16": "波浪注意報", "17": "融雪注意報", "18": "洪水注意報",
  "19": "高潮注意報", "20": "濃霧注意報", "21": "乾燥注意報", "22": "なだれ注意報",
  "23": "低温注意報", "24": "霜注意報", "25": "着氷注意報", "26": "着雪注意報",
  "32": "暴風雪特別警報", "33": "大雨特別警報", "35": "暴風特別警報",
  "36": "高潮特別警報", "37": "波浪特別警報", "38": "大雪特別警報",
};

// ⚠️ 重要度: 特別警報=4 / 警報=3 / 注意報=2
export function warningSeverity(code: string, name: string): number {
  const ci = Number.parseInt(code, 10);
  if (Number.isFinite(ci) && ci >= 32 && ci <= 38) return 4;
  if (name.endsWith("警報")) return 3;
  return 2;
}

// 🌐 官署コードから気象庁の警報 JSON の URL を作る
export function buildWarningUrl(officeCode: string): string {
  return `https://www.jma.go.jp/bosai/warning/data/warning/${officeCode}.json`;
}

// ------------------------------------------
// 📍 区域名の解決 (area.json の class10s)
// ------------------------------------------
// 📍 area.json の class10s から「区域コード → 区域名」の対応を取り出す
export function parseClass10Names(data: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!data || typeof data !== "object") return out;
  const class10s = (data as Record<string, unknown>).class10s;
  if (!class10s || typeof class10s !== "object") return out;
  for (const [code, value] of Object.entries(class10s as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === "string" && name) out.set(code, name);
    }
  }
  return out;
}

// ------------------------------------------
// ⚠️ 警報・注意報の変換
// ------------------------------------------
// ⚠️ 1官署分の警報 JSON を、一次細分区域 (areaTypes[0]) ごとの下書きに
// 変換する。除外規則:
// - status が「解除」「発表警報・注意報はなし」のエントリは除外する
// - status が空・欠落のエントリは継続中として扱う
// - コード表に無いコードは「その他の警報・注意報 (コードXX)」として残す
// - 区域内は名称ごとに最大重要度で重複排除し、重要度降順→名称順に整列する
// 発表中の警報が1件も無い区域は下書きを作らない (有効集合に含めない)
export function parseWarningOffice(
  data: unknown,
  officeCode: string,
  resolveAreaName?: (areaCode: string) => string | undefined,
): WarningDraft[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, any>;
  const headline = typeof root.headlineText === "string" ? root.headlineText : "";
  const reportDatetime = typeof root.reportDatetime === "string" ? root.reportDatetime : "";
  const prefName = OFFICE_PREF_NAMES.get(officeCode) ?? "";
  const areaTypes: any[] = Array.isArray(root.areaTypes) ? root.areaTypes : [];
  const areasRaw: any[] =
    areaTypes.length > 0 && Array.isArray(areaTypes[0]?.areas) ? areaTypes[0].areas : [];
  const out: WarningDraft[] = [];
  for (const area of areasRaw) {
    const areaCode = String(area?.code ?? "");
    if (!areaCode) continue;
    // 🔁 区域内では同じ名称は最大重要度で重複排除する
    const found = new Map<string, WarningEntry>();
    const warningsRaw: any[] = Array.isArray(area?.warnings) ? area.warnings : [];
    for (const w of warningsRaw) {
      const code = String(w?.code ?? "");
      if (!code) continue;
      const status = typeof w?.status === "string" ? w.status : "";
      if (status === "解除" || status === "発表警報・注意報はなし") continue;
      const name = JMA_WARNING_CODES[code] ?? `その他の警報・注意報（コード${code}）`;
      const entry: WarningEntry = { code, name, status, severity: warningSeverity(code, name) };
      const prev = found.get(name);
      if (!prev || entry.severity > prev.severity) found.set(name, entry);
    }
    if (found.size === 0) continue;
    const warnings = [...found.values()].sort(
      (a, b) => b.severity - a.severity || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    out.push({
      kind: "warning",
      key: `warning:${officeCode}:${areaCode}`,
      officeCode,
      prefName,
      areaCode,
      areaName:
        resolveAreaName?.(areaCode) ??
        (typeof area?.name === "string" && area.name ? area.name : `区域 ${areaCode}`),
      reportDatetime,
      headline,
      warnings,
      maxSeverity: Math.max(...warnings.map((w) => w.severity)),
      time: reportDatetime,
      released: false,
    });
  }
  return out;
}

// ------------------------------------------
// 🌀 台風
// ------------------------------------------
// 🌐 台風情報 (targetTc.json) の URL
export const TYPHOON_URL = "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json";

// 📌 表示行の組み立てで優先的に拾うキー
const TYPHOON_KNOWN_KEYS = ["name", "typhoonName", "title", "number", "typhoonNumber", "tcNumber"] as const;

// 🔁 連結部品の重複排除: 完全一致に加え、他の部品に含まれる部品
// (例: 台風名「台風第10号」に対する号数「10」) も落とす
export function dropContainedParts(parts: string[]): string[] {
  return parts.filter(
    (v, i) => !parts.some((o, j) => j !== i && o.length > v.length && o.includes(v)),
  );
}

// 🌀 targetTc.json の内容を防御的に整形する。台風が無ければ []。
// フィールド構成が不明な要素は文字列フィールドを連結して表示する
export function typhoonLines(data: unknown): string[] {
  const lines: string[] = [];
  if (!Array.isArray(data)) return lines;
  for (const el of data) {
    if (typeof el === "string") {
      if (el.trim()) lines.push(el.trim());
      continue;
    }
    if (!el || typeof el !== "object") continue;
    const record = el as Record<string, unknown>;
    const picked: string[] = [];
    for (const key of TYPHOON_KNOWN_KEYS) {
      const v = record[key];
      if (typeof v === "string" && v.trim() && !picked.includes(v.trim())) picked.push(v.trim());
    }
    const parts =
      picked.length > 0
        ? dropContainedParts(picked)
        : dropContainedParts(
            Object.values(record)
              .filter((v): v is string => typeof v === "string" && v.trim() !== "")
              .map((v) => v.trim()),
          );
    if (parts.length > 0) lines.push("・" + parts.join(" "));
  }
  return lines;
}

// 📝 文字列として読める最初の値を返す (無ければ null)
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

// 🌀 targetTc の1要素を台風イベントの下書きにする。表示行が作れなければ
// 台風なしとして null を返す
export function buildTyphoonDraft(el: unknown): TyphoonDraft | null {
  const lines = typhoonLines([el]);
  if (lines.length === 0) return null;
  if (!el || typeof el !== "object" || typeof el === "string") {
    // 📌 文字列要素は名称ベースのキーで最低限のイベントにする
    const label = typeof el === "string" ? el.trim() : lines[0];
    return {
      kind: "typhoon",
      key: `typhoon:${label}`,
      number: null,
      name: label,
      englishName: null,
      lines,
      fields: {},
      time: "",
    };
  }
  const record = el as Record<string, unknown>;
  // 📦 要素のスカラー値 (文字列・数値) は落とさず fields に保持する。
  // 位置・中心気圧・進路予報なども、データ源に含まれていればここに入る
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" && v.trim()) fields[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
  }
  const number = firstString(record, ["typhoonNumber", "number", "tcNumber"]);
  const name = firstString(record, ["name", "typhoonName", "title"]);
  const englishName = firstString(record, ["englishName", "enName", "english"]);
  // 🕐 日時らしいスカラーがあれば代表時刻にする (無ければ捏造せず "")
  let time = "";
  for (const [k, v] of Object.entries(fields)) {
    if (/time|date/i.test(k) && typeof v === "string") {
      time = v;
      break;
    }
  }
  const keyLabel = number ?? name ?? englishName ?? lines[0].replace(/^・/, "");
  return {
    kind: "typhoon",
    key: `typhoon:${keyLabel}`,
    number,
    name,
    englishName,
    lines,
    fields,
    time,
  };
}

// 🌀 targetTc.json 全体を台風イベントの下書き一覧に変換する。
// 台風が無ければ (実データの [] を含む) 空配列を返す
export function parseTyphoons(data: unknown): TyphoonDraft[] {
  if (!Array.isArray(data)) return [];
  const out: TyphoonDraft[] = [];
  for (const el of data) {
    const draft = buildTyphoonDraft(el);
    if (draft) out.push(draft);
  }
  return out;
}
