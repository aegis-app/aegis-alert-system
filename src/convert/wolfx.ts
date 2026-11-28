// ==========================================
// 🔀 Wolfx の変換 (EEW の予報経路)
// ==========================================
// 📌 Wolfx `jma_eew` は緊急地震速報 (予報) の再配信で、`isWarn` が
// 警報への格上げを示す。同一視キーは P2P 556 の変換 (convert/p2p.ts)
// と完全に一致させ、同じ EEW が経路によらずストア上で同一視される
// ようにする。取得 (HTTP / WebSocket) は Phase 2 の領分で、ここは
// 純粋な変換だけを行う。
import { depthOrNull, eewBaseKey, formatP2pTime, numOrNull, parseP2pTime, roundedCoordKey } from "../util.js";
import type { EewDraft } from "../types.js";

// 🚨 jma_eew は最新1件のみを保持するため、古い EEW を遅れて取り込まないよう、
// 発表からこの時間を過ぎたものは使わない (既定5分)
const MAX_AGE_MS = 5 * 60 * 1000;

// ------------------------------------------
// 📳 震度文字列 → 数値コード
// ------------------------------------------
// 📳 Wolfx の震度は "5弱" のような弱/強表記。P2P の数値コードへ変換する。
// 不明な表記は P2P の不明センチネル (-1) にそろえる
const INTENSITY_CODES: Record<string, number> = {
  "1": 10,
  "2": 20,
  "3": 30,
  "4": 40,
  "5弱": 45,
  "5強": 50,
  "6弱": 55,
  "6強": 60,
  "7": 70,
  "5-": 45,
  "5+": 50,
  "6-": 55,
  "6+": 60,
};

// 🌍 Wolfx の震度表記 (5弱など) を P2P の数値コードに変換する
export function wolfxIntensityToScale(v: unknown): number {
  if (typeof v !== "string") return -1;
  // 📌 全角数字を半角へそろえる (電文由来の表記ゆれ対策)
  const s = v
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return INTENSITY_CODES[s] ?? -1;
}

// ------------------------------------------
// 📍 WarnArea の地域名 → 都道府県
// ------------------------------------------
// 📍 Wolfx の WarnArea は細分区域名 (Chiiki) だけを持つため、地域名の
// 接頭辞から都道府県を導出する。導出できない地域は対象にしない
const PREFECTURE_NAMES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

// 📍 都道府県名で始まらない地域名の特例 (地方名・諸島名)
const SPECIAL_AREA_PREFS: { prefix: string; pref: string }[] = [
  { prefix: "道南", pref: "北海道" },
  { prefix: "道央", pref: "北海道" },
  { prefix: "道北", pref: "北海道" },
  { prefix: "道東", pref: "北海道" },
  { prefix: "伊豆諸島", pref: "東京都" },
  { prefix: "小笠原", pref: "東京都" },
];

// 📍 地域名の先頭から都道府県を導き出す
function prefOfArea(chiiki: string): string | null {
  for (const pref of PREFECTURE_NAMES) {
    if (chiiki.startsWith(pref)) return pref;
  }
  for (const s of SPECIAL_AREA_PREFS) {
    if (chiiki.startsWith(s.prefix)) return s.pref;
  }
  return null;
}

// 📌 WarnArea の Time ("HHMMSS"、不明は "//////") をフル表記へ変換する。
// 日付は発生時刻の日を使い、発生時刻より前になる場合は1日進める
function warnAreaArrival(originTime: string, hhmmss: string): string | null {
  if (!/^\d{6}$/.test(hhmmss)) return null;
  const origin = parseP2pTime(originTime);
  if (!origin) return null;
  const datePart = originTime.slice(0, 10);
  const candidate = `${datePart} ${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}`;
  const candidateDate = parseP2pTime(candidate);
  if (!candidateDate) return null;
  if (candidateDate.getTime() >= origin.getTime()) return candidate;
  return formatP2pTime(new Date(candidateDate.getTime() + 24 * 60 * 60 * 1000));
}

// ------------------------------------------
// 🔀 変換
// ------------------------------------------
// 📥 変換のオプション (鮮度判定の基準時刻はテストで固定できる)
export interface WolfxParseOptions {
  // 🔍 鮮度判定の基準時刻 (テスト用に差し替え可能)
  now?: Date;
  // 🚨 発表からこの時間を過ぎた EEW は使わない (既定5分)
  maxAgeMs?: number;
}

// 🔀 Wolfx の jma_eew JSON を共通フォーマットの EEW 下書きへ変換する。
// 使えない場合は null。key / baseKey は P2P 556 の変換と完全に同じ規則で
// 生成し、P2P 経由の同じ EEW とストア上で同一視されるようにする
export function parseWolfxEew(data: unknown, options: WolfxParseOptions = {}): EewDraft | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  // 📌 訓練報は取り込まない
  if (d.isTraining === true) return null;
  const announced = typeof d.AnnouncedTime === "string" ? d.AnnouncedTime : "";
  const announcedDate = parseP2pTime(announced);
  // 🕐 発表時刻が読めないものは鮮度を担保できないため使わない
  if (!announcedDate) return null;
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  if (now.getTime() - announcedDate.getTime() > maxAgeMs) return null;

  const cancel = d.isCancel === true;
  const hypoName =
    typeof d.Hypocenter === "string" && d.Hypocenter.trim() !== "" ? d.Hypocenter : "不明";
  const originTime =
    typeof d.OriginTime === "string" && d.OriginTime !== "" ? d.OriginTime : announced;
  const lat = numOrNull(d.Latitude);
  const lon = numOrNull(d.Longitude);
  const latOk = lat !== null && lat >= -90 && lat <= 90 ? lat : null;
  const lonOk = lon !== null && lon >= -180 && lon <= 180 ? lon : null;
  // 📌 Wolfx の Magnitude は未知値の互換値として 0 が入るため、0 は不明として null にする
  const magRaw = numOrNull(d.Magnitude);
  const estMagnitude = magRaw !== null && magRaw > 0 ? magRaw : null;

  const prefs: string[] = [];
  const areaArrivals: { pref: string; arrivalTime: string }[] = [];
  const areaScales: { pref: string; name: string; scale: number; scaleTo: number | null }[] = [];
  for (const a of Array.isArray(d.WarnArea) ? d.WarnArea : []) {
    const chiiki = typeof a?.Chiiki === "string" ? a.Chiiki : "";
    if (!chiiki) continue;
    const pref = prefOfArea(chiiki);
    if (!pref) continue; // 都道府県を導出できない地域は対象にしない
    if (!prefs.includes(pref) && prefs.length < 6) prefs.push(pref);
    const scale = wolfxIntensityToScale(a?.Shindo1);
    // 📳 上限 (scaleTo) は Wolfx 由来では持たない: Shindo2 は上限としての
    // 意味論が確定しておらず、無理に作らない
    if (scale > 0) areaScales.push({ pref, name: chiiki, scale, scaleTo: null });
    if (typeof a?.Time === "string") {
      const arrivalTime = warnAreaArrival(originTime, a.Time);
      if (arrivalTime) areaArrivals.push({ pref, arrivalTime });
    }
  }

  const serialRaw = numOrNull(d.Serial);
  const eventId =
    typeof d.EventID === "string" && d.EventID !== ""
      ? d.EventID
      : typeof d.EventID === "number"
        ? String(d.EventID)
        : null;
  // 📌 同一視キーは P2P 556 と同じ規則 (JMA イベント ID 優先)
  const coordKey = roundedCoordKey(latOk, lonOk);
  const baseKey = eewBaseKey(eventId, originTime, coordKey, hypoName);
  const draft: EewDraft = {
    kind: "eew",
    key: baseKey + (cancel ? "-cancel" : ""),
    baseKey,
    time: announced,
    originTime,
    cancel,
    // 🌤️ jma_eew は予報の再配信で、isWarn=true のとき警報に格上げされている
    isWarn: d.isWarn === true,
    // 📌 最終報フラグ (クライアントが「最終報」表示に使う)
    isFinal: d.isFinal === true,
    serial: serialRaw !== null ? Math.trunc(serialRaw) : null,
    eventId,
    isAssumption: d.isAssumption === true,
    hypocenter: hypoName,
    estScale: wolfxIntensityToScale(d.MaxIntensity),
    estMagnitude,
    prefs,
    lat: latOk,
    lon: lonOk,
    depthKm: depthOrNull(d.Depth),
    areaArrivals,
    areaScales,
  };
  return draft;
}
