// ==========================================
// 🔀 DMDSS (dmdata.jp) の電文変換
// ==========================================
// 📌 DMDATA API v2 の WebSocket で届く気象庁防災情報XML電文を、共通
// フォーマット (eew / quake / tsunami) へ変換する。接続そのものは
// Phase 2 の領分で、ここは封筒のデコードと電文変換だけを行う。
// 📌 対象区分は eew.forecast (緊急地震速報) と telegram.earthquake
// (地震・津波関連) の2つ。変換先のフィールド規則は P2P 経路
// (convert/p2p.ts) にそろえ、同一地震が両経路から届いても同一イベント
// として統合されるようにする。
// ⚠️ 本モジュールの変換は気象庁の公式フォーマット仕様に基づいて
// 実装したもので、DMDSS 経由の実電文での検証はキー有効化後の残タスク
// である (洪水予報・記録的短時間大雨情報と同じ扱い)。
import { gunzipSync } from "node:zlib";
import { depthOrNull, eewBaseKey, formatP2pTime, numOrNull, roundedCoordKey } from "../util.js";
import {
  childOf,
  childText,
  descendants,
  parseTelegramParts,
  type TelegramParts,
  type XmlNode,
} from "./xml.js";
import { wolfxIntensityToScale } from "./wolfx.js";
import type { EewDraft, QuakeDraft, TsunamiDraft } from "../types.js";

// 📌 観測点などの要素型は types.ts ではインライン定義のため、ドラフト型
// から取り出して使う
type QuakePoint = QuakeDraft["points"][number];
type PrefScale = QuakeDraft["prefScales"][number];
type TsunamiArea = TsunamiDraft["areas"][number];

// ------------------------------------------
// 📦 data メッセージの封筒と body のデコード
// ------------------------------------------
// 📌 DMDATA API v2 の WebSocket `data` メッセージ。body は format /
// compression / encoding の組み合わせで運ばれる: 対象電文 (XML) は
// gzip 圧縮 + base64 が基本形で、一部電文は非圧縮 (encoding は
// utf-8 または base64)
export interface DmdssDataMessage {
  type: "data";
  classification?: string;
  id?: string;
  head?: { type?: string; author?: string; time?: string; test?: boolean; xml?: boolean };
  format?: string | null;
  compression?: string | null;
  encoding?: string | null;
  body?: string;
}

// 📥 data メッセージの body を XML 文字列へ戻す。対応できない形式
// (zip 圧縮など) は null を返し、呼び出し側がログして読み飛ばす
export function decodeDmdssBody(msg: DmdssDataMessage): string | null {
  if (typeof msg.body !== "string") return null;
  if (msg.format !== "xml") return null;
  let buf: Buffer;
  if (msg.encoding === "base64") {
    buf = Buffer.from(msg.body, "base64");
  } else {
    // 📌 encoding が "utf-8" の場合と、欠けている場合 (非圧縮の平文扱い)
    buf = Buffer.from(msg.body, "utf-8");
  }
  if (msg.compression === "gzip") {
    try {
      buf = gunzipSync(buf);
    } catch {
      return null;
    }
  } else if (msg.compression) {
    // ⚠️ zip 圧縮は Node 標準機能では展開できない。対象の地震・EEW・
    // 津波電文は気象庁の一覧表で gzip 側のため、ここでは読み飛ばす
    return null;
  }
  return buf.toString("utf-8");
}

// ------------------------------------------
// 🧩 XML の小物
// ------------------------------------------
// 🕐 ISO 8601 (JST オフセット付き) → P2P 表記 "yyyy/MM/dd HH:mm:ss"
function isoToP2p(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatP2pTime(d);
}

// 🆔 JMA イベント ID (14桁 = 発生時刻) → P2P 表記の発生時刻
function eventIdToP2pTime(eventId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(eventId.trim());
  if (!m) return "";
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// 🌍 ISO6709 形式の座標文字列 ("+32.3+130.5-10000/" 等) を分解する。
// 第3要素は深さ (m、符号は基準面方向) なので絶対値を km へ直す
function parseCoordinate(text: string): { lat: number | null; lon: number | null; depthKm: number | null } {
  const nums = [...text.matchAll(/([+-]\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const lat = nums.length >= 1 ? nums[0]! : null;
  const lon = nums.length >= 2 ? nums[1]! : null;
  const depthKm = nums.length >= 3 ? depthOrNull(Math.abs(nums[2]!) / 1000) : null;
  return { lat, lon, depthKm };
}

// 🏔 震源要素 (Body/Earthquake) の読み取り結果
interface HypocenterInfo {
  name: string;
  lat: number | null;
  lon: number | null;
  depthKm: number | null;
  magnitude: number | null;
  condition: string;
  originIso: string;
}

// 🏔 Body/Earthquake (震源要素) を読む。要素が無ければ null
function readEarthquake(body: XmlNode | null): HypocenterInfo | null {
  if (!body) return null;
  const eq = childOf(body, "Earthquake");
  if (!eq) return null;
  const hypo = childOf(eq, "Hypocenter");
  const area = hypo ? childOf(hypo, "Area") : undefined;
  const coordText = area ? childText(area, "Coordinate") : "";
  const coord = parseCoordinate(coordText);
  const magEl = childOf(eq, "Magnitude");
  const mag = magEl ? numOrNull(magEl.text.trim()) : null;
  return {
    name: area ? childText(area, "Name") : "",
    lat: coord.lat,
    lon: coord.lon,
    depthKm: coord.depthKm,
    // 📌 P2P 経路と同じく、負のマグニチュードは欠測として null にする
    magnitude: mag !== null && mag >= 0 ? mag : null,
    condition: childText(eq, "Condition"),
    originIso: childText(eq, "OriginTime"),
  };
}

// 💬 Comments 内のコメント文を取り出す (Text 子要素がある形と、要素自体が
// 本文の形の両方に対応する)
function commentText(comments: XmlNode | undefined, name: string): string {
  if (!comments) return "";
  const el = childOf(comments, name);
  if (!el) return "";
  return childText(el, "Text") || el.text.trim();
}

// 🚫 訓練・試験電文 (Control/Status が「通常」以外) は取り込まない
function isNormalStatus(parts: TelegramParts): boolean {
  const control = childOf(parts.root, "Control");
  const status = control ? childText(control, "Status") : "";
  return status === "" || status === "通常";
}

// 🆔 Head の EventID (JMA イベント ID) を取り出す
function headEventId(parts: TelegramParts): string {
  const head = childOf(parts.root, "Head");
  return head ? childText(head, "EventID") : "";
}

// 🔢 Head の Serial (報番号) を取り出す
function headSerial(parts: TelegramParts): number | null {
  const head = childOf(parts.root, "Head");
  return head ? numOrNull(childText(head, "Serial")) : null;
}

// 🎯 Intensity/Forecast の Area / Pref 直下にある Category/Kind/Name
function firstKindName(node: XmlNode): string {
  const category = childOf(node, "Category");
  const kind = category ? childOf(category, "Kind") : undefined;
  return kind ? childText(kind, "Name") : "";
}

// ------------------------------------------
// 🚨 緊急地震速報 (VXSE43 警報 / VXSE45 地震動予報) → eew
// ------------------------------------------
// 📌 VXSE45 は現行の予報電文 (旧 VXSE44 は終了し、予想震度と長周期
// 地震動階級を持つ VXSE45 へ置き換わった)。両形式とも Body の構造
// (Earthquake + Intensity/Forecast) は共通のため同じ変換を使う。
// 警報判定は、電文種別 (VXSE43) と、地域ごとの Category/Kind/Name
// (「緊急地震速報 (警報)」) の両方から行う
export function parseDmdssEew(xml: string, telegramType: string): EewDraft | null {
  const parts = parseTelegramParts(xml);
  if (!parts || !isNormalStatus(parts)) return null;
  const eventId = headEventId(parts);
  const serial = headSerial(parts);
  const announced = isoToP2p(parts.reportDateTime);
  if (!announced) return null;
  const eq = readEarthquake(parts.body);
  const originTime =
    (eq?.originIso ? isoToP2p(eq.originIso) : "") ||
    eventIdToP2pTime(eventId) ||
    announced;
  const cancel = parts.infoType === "取消";

  // 🗺 予想震度 (Intensity/Forecast) を府県・地域単位で読む
  const prefs: string[] = [];
  const areaArrivals: { pref: string; arrivalTime: string }[] = [];
  const areaScales: { pref: string; name: string; scale: number; scaleTo: number | null }[] = [];
  let isWarn = telegramType === "VXSE43" || parts.controlTitle.includes("警報");
  let estScale = -1;
  const intensity = parts.body ? childOf(parts.body, "Intensity") : undefined;
  const forecast = intensity ? childOf(intensity, "Forecast") : undefined;
  if (forecast) {
    for (const pref of forecast.children.filter((c) => c.name === "Pref")) {
      const prefName = childText(pref, "Name");
      if (prefName && !prefs.includes(prefName)) prefs.push(prefName);
      let earliestArrival = "";
      for (const area of pref.children.filter((c) => c.name === "Area")) {
        const areaName = childText(area, "Name");
        const kind = firstKindName(area);
        if (kind.includes("警報")) isWarn = true;
        const fi = childOf(area, "ForecastInt");
        const from = fi ? wolfxIntensityToScale(childText(fi, "From")) : -1;
        const toRaw = fi ? wolfxIntensityToScale(childText(fi, "To")) : -1;
        if (from > estScale) estScale = from;
        if (prefName && areaName && from > 0) {
          areaScales.push({
            pref: prefName,
            name: areaName,
            scale: from,
            scaleTo: toRaw > 0 ? toRaw : null,
          });
        }
        const arrival = isoToP2p(childText(area, "ArrivalTime"));
        if (arrival && (!earliestArrival || arrival < earliestArrival)) earliestArrival = arrival;
      }
      if (prefName && earliestArrival) areaArrivals.push({ pref: prefName, arrivalTime: earliestArrival });
    }
    // 📌 地域別が無い電文では Forecast 直下の ForecastInt を代表値にする
    if (estScale < 0) {
      const fi = childOf(forecast, "ForecastInt");
      if (fi) estScale = wolfxIntensityToScale(childText(fi, "From"));
    }
  }

  const lat = eq?.lat ?? null;
  const lon = eq?.lon ?? null;
  const hypocenter = eq?.name || "不明";
  const baseKey = eewBaseKey(eventId || null, originTime, roundedCoordKey(lat, lon), hypocenter);
  return {
    kind: "eew",
    // 📌 key は P2P / Wolfx 経路と完全に同じ規則 (取消時のみ "-cancel")
    key: baseKey + (cancel ? "-cancel" : ""),
    baseKey,
    time: announced,
    originTime,
    serial,
    eventId: eventId || null,
    hypocenter,
    lat,
    lon,
    depthKm: eq?.depthKm ?? null,
    // 📌 Wolfx 経路と同じく、正の値のときだけ推定マグニチュードとする
    estMagnitude: eq?.magnitude != null && eq.magnitude > 0 ? eq.magnitude : null,
    estScale,
    isWarn,
    // 📌 XML には最終報フラグが無いため P2P 556 経路と同じく false。
    // 終端は取消電文 (cancel) で表す
    isFinal: false,
    cancel,
    isAssumption: (eq?.condition ?? "").includes("仮定震源要素"),
    prefs: prefs.slice(0, 6),
    areaArrivals,
    areaScales,
  };
}

// ------------------------------------------
// 🌋 地震情報 (VXSE51 震度速報 / VXSE52 震源 / VXSE53 震源・震度) → quake
// ------------------------------------------
// 📄 電文1件を部品として読んだ結果 (同一 EventID の複数電文を蓄積側で統合する)
export interface QuakeTelegramPart {
  // 📌 報の完全さ: 1=震度速報 / 2=震源 / 3=震源・震度 / 4=詳細 (観測点あり)
  typeRank: number;
  issueType: string;
  reportIso: string;
  infoType: string;
  eq: HypocenterInfo | null;
  maxScale: number;
  points: QuakePoint[];
  forecastComment: string;
  freeFormComment: string;
}

// 📄 地震電文1件を部品として読む
export function parseDmdssQuakePart(xml: string, telegramType: string): QuakeTelegramPart | null {
  const parts = parseTelegramParts(xml);
  if (!parts || !isNormalStatus(parts)) return null;
  const eq = readEarthquake(parts.body);
  const intensity = parts.body ? childOf(parts.body, "Intensity") : undefined;
  const observation = intensity ? childOf(intensity, "Observation") : undefined;
  const points: QuakePoint[] = [];
  let hasStations = false;
  if (observation) {
    for (const pref of observation.children.filter((c) => c.name === "Pref")) {
      const prefName = childText(pref, "Name");
      if (!prefName) continue;
      for (const area of pref.children.filter((c) => c.name === "Area")) {
        const areaName = childText(area, "Name");
        const areaScale = wolfxIntensityToScale(childText(area, "MaxInt"));
        if (areaName && areaScale > 0) {
          points.push({ pref: prefName, name: areaName, scale: areaScale, isArea: true });
        }
        for (const st of descendants(area, "IntensityStation")) {
          const stName = childText(st, "Name");
          const stScale = wolfxIntensityToScale(childText(st, "Int"));
          if (stName && stScale > 0) {
            points.push({ pref: prefName, name: stName, scale: stScale, isArea: false });
            hasStations = true;
          }
        }
      }
    }
  }
  let typeRank: number;
  let issueType: string;
  if (telegramType === "VXSE51") {
    typeRank = 1;
    issueType = "ScalePrompt";
  } else if (telegramType === "VXSE52") {
    typeRank = 2;
    issueType = "Destination";
  } else {
    // VXSE53: 観測点 (IntensityStation) を含めば詳細報として扱う
    typeRank = hasStations ? 4 : 3;
    issueType = hasStations ? "DetailScale" : "ScaleAndDestination";
  }
  const comments = parts.body ? childOf(parts.body, "Comments") : undefined;
  return {
    typeRank,
    issueType,
    reportIso: parts.reportDateTime,
    infoType: parts.infoType,
    eq,
    maxScale: observation ? wolfxIntensityToScale(childText(observation, "MaxInt")) : -1,
    points,
    forecastComment: commentText(comments, "ForecastComment"),
    freeFormComment: commentText(comments, "FreeFormComment"),
  };
}

// 🌊 津波の有無・程度を ForecastComment の定型文から判定する。
// ⚠️ P2P 経路では JMA の分類値がそのまま来るが、XML では本文の文面から
// 推定するしかない。実電文での検証は残タスク
export function tsunamiKindFromComment(text: string): string {
  if (!text) return "Unknown";
  // 📌 「若干の海面変動」の定型文にも「被害の心配はありません」が
  // 含まれるため、こちらを先に判定する
  if (text.includes("若干の海面変動")) return "Forecast";
  if (text.includes("心配はありません")) return "None";
  if (text.includes("調査中")) return "Checking";
  if (text.includes("大津波警報") || text.includes("津波警報")) return "Warning";
  if (text.includes("津波注意報")) return "Advisory";
  return "Unknown";
}

// 📦 同一 EventID の地震電文を蓄積し、P2P の buildQuakeEvent と同じ規則で
// 1件の quake ドラフトへ統合するクラス。震度速報→震源→震源・震度の順に
// 届く電文をまたいで観測点を合体させるために必要 (P2P 経路は API 側が
// 履歴をまとめて返すため不要だったが、電文プッシュでは自前で持つ)
export class DmdssQuakeAccumulator {
  private groups = new Map<string, { parts: QuakeTelegramPart[]; updatedAt: number }>();
  private readonly maxGroups: number;
  private readonly ttlMs: number;

  constructor(maxGroups = 200, ttlMs = 3 * 60 * 60 * 1000) {
    this.maxGroups = maxGroups;
    this.ttlMs = ttlMs;
  }

  // 📥 電文1件を取り込み、統合済みドラフトを返す。対象外は null
  ingest(xml: string, telegramType: string, now = Date.now()): QuakeDraft | null {
    const parts0 = parseTelegramParts(xml);
    if (!parts0) return null;
    const part = parseDmdssQuakePart(xml, telegramType);
    if (!part) return null;
    const eventId = headEventId(parts0);
    const groupKey =
      eventId ||
      `${part.eq?.originIso ?? ""}|${part.eq?.name ?? ""}|${parts0.reportDateTime}`;
    let group = this.groups.get(groupKey);
    if (!group) {
      group = { parts: [], updatedAt: now };
      this.groups.set(groupKey, group);
    }
    group.parts.push(part);
    group.updatedAt = now;
    this.prune(now);
    return this.build(group.parts, eventId || null);
  }

  // 🧹 TTL 超過と件数超過のグループを落とす
  private prune(now: number): void {
    for (const [k, g] of this.groups) {
      if (now - g.updatedAt > this.ttlMs) this.groups.delete(k);
    }
    while (this.groups.size > this.maxGroups) {
      const oldest = this.groups.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.groups.delete(oldest);
    }
  }

  // 🔀 蓄積した部品群から統合済みドラフトを作る
  private build(parts: QuakeTelegramPart[], eventId: string | null): QuakeDraft | null {
    // 📌 最も内容の揃った電文を代表にする (P2P の primary 選定と同じ規則)
    const primary = [...parts].sort((a, b) => b.typeRank - a.typeRank)[0]!;
    const eq = [...parts].reverse().find((p) => p.eq)?.eq ?? null;
    // 📌 震度速報 (VXSE51) は震源要素を持たないため、発生時刻はイベント
    // ID (発生時刻そのもの) から復元する
    const originTime =
      (eq?.originIso ? isoToP2p(eq.originIso) : "") || eventIdToP2pTime(eventId ?? "");
    if (!originTime) return null;
    const announcedTime = isoToP2p(primary.reportIso);
    const latestReport = parts
      .map((p) => isoToP2p(p.reportIso))
      .filter(Boolean)
      .sort()
      .at(-1) ?? announcedTime;

    // 🗺 観測点は (府県|地点名|地域か) で重ね、最大震度を残す (P2P と同じ)
    const pointMap = new Map<string, QuakePoint>();
    for (const part of parts) {
      for (const pt of part.points) {
        const k = `${pt.pref}|${pt.name}|${pt.isArea ? "a" : "s"}`;
        const prev = pointMap.get(k);
        if (!prev || pt.scale > prev.scale) pointMap.set(k, pt);
      }
    }
    const points = [...pointMap.values()].sort(
      (a, b) => b.scale - a.scale || a.name.localeCompare(b.name, "ja"),
    );
    // 📌 代表地点は最大震度の中から観測点を優先する (P2P と同じ規則)
    const atMax = points.filter((p) => p.scale === (points[0]?.scale ?? -1));
    const topPoint = atMax.find((p) => !p.isArea) ?? atMax[0] ?? null;
    const prefMap = new Map<string, number>();
    for (const pt of points) {
      if (pt.scale > (prefMap.get(pt.pref) ?? 0)) prefMap.set(pt.pref, pt.scale);
    }
    const prefScales: PrefScale[] = [...prefMap.entries()]
      .map(([pref, scale]) => ({ pref, scale }))
      .sort((a, b) => b.scale - a.scale || a.pref.localeCompare(b.pref, "ja"));
    const maxScale = Math.max(-1, ...parts.map((p) => p.maxScale), ...points.map((p) => p.scale));

    // 🌍 国外地震の推定: 観測点が無く、震央が日本の範囲の外にあるもの。
    // P2P の Foreign は発生時刻が電文に無い扱いだが、XML には常にあるため
    // キーは発生時刻ベースで作り、time フィールドだけ P2P の慣例
    // (国外は発表時刻) にそろえる
    const foreign =
      points.length === 0 &&
      eq?.lat != null &&
      eq?.lon != null &&
      (eq.lat < 24 || eq.lat > 46 || eq.lon < 122 || eq.lon > 150);
    const hypocenter = eq?.name || "不明";
    const coordKey = roundedCoordKey(eq?.lat ?? null, eq?.lon ?? null);
    const key = coordKey
      ? `551:${originTime}|${coordKey}`
      : `551:${originTime}|${hypocenter}`;
    const freeForm = [...parts].reverse().find((p) => p.freeFormComment)?.freeFormComment ?? "";
    // 🌊 津波の見通しは、確定した値を持つ電文を優先する (P2P と同じ規則)
    const kindOf = (p: QuakeTelegramPart): string => tsunamiKindFromComment(p.forecastComment);
    const determined = [...parts]
      .reverse()
      .find((p) => kindOf(p) !== "Checking" && kindOf(p) !== "Unknown");
    const tsunamiKind = determined ? kindOf(determined) : kindOf(primary);
    return {
      kind: "quake",
      key,
      time: foreign ? latestReport : originTime,
      // 📌 電文 ID は JMA イベント ID (P2P 経路の P2P 電文 ID とは別体系。
      // 同一視はキー側で行うため、ここは由来が分かる値をそのまま持つ)
      telegramId: eventId ?? "",
      issueType: foreign ? "Foreign" : primary.issueType,
      issueCorrect: primary.infoType,
      foreign,
      // 📌 P2P 経路にそろえ、originTime は国外地震のときだけ持つ
      // (国内は time が発生時刻そのもの)
      originTime: foreign ? originTime : null,
      announcedTime,
      hypocenter,
      lat: eq?.lat ?? null,
      lon: eq?.lon ?? null,
      depthKm: eq?.depthKm ?? null,
      magnitude: eq?.magnitude ?? null,
      maxScale,
      points,
      topPoint: topPoint?.name ?? null,
      topPointIsArea: topPoint?.isArea ?? false,
      prefScales,
      tsunamiKind,
      tsunamiText: freeForm || null,
    };
  }
}

// ------------------------------------------
// 🌊 津波警報・注意報・予報 (VTSE41) → tsunami
// ------------------------------------------
// 📌 グレードの順位 (最上位グレードの判定用)
const TSUNAMI_GRADE_RANK: Record<string, number> = { MajorWarning: 3, Warning: 2, Watch: 1 };

// 📌 区域ごとの種別名 → grade 表記。津波予報 (若干の海面変動) は
// P2P の grade 段階に無いため "Forecast" とし、最上位 grade の判定では
// 段階外 (Unknown 相当) として扱う
function tsunamiGradeOf(kindName: string): string {
  if (kindName.includes("大津波警報")) return "MajorWarning";
  if (kindName.includes("津波警報")) return "Warning";
  if (kindName.includes("津波注意報")) return "Watch";
  if (kindName.includes("津波予報")) return "Forecast";
  return "Unknown";
}

// 🌊 津波電文を下書きへ変換する。発表日時が読めなければ null
export function parseDmdssTsunami(xml: string): TsunamiDraft | null {
  const parts = parseTelegramParts(xml);
  if (!parts || !isNormalStatus(parts)) return null;
  const time = isoToP2p(parts.reportDateTime);
  if (!time) return null;
  const tsunami = parts.body ? childOf(parts.body, "Tsunami") : undefined;
  const forecast = tsunami ? childOf(tsunami, "Forecast") : undefined;
  const areas: TsunamiArea[] = [];
  if (forecast) {
    for (const area of forecast.children.filter((c) => c.name === "Area")) {
      const name = childText(area, "Name");
      if (!name) continue;
      const grade = tsunamiGradeOf(firstKindName(area));
      const firstHeight = childOf(area, "FirstHeight");
      const arrivalIso = firstHeight ? childText(firstHeight, "ArrivalTime") : "";
      const arrival = arrivalIso ? isoToP2p(arrivalIso) : "";
      const condition = firstHeight ? childText(firstHeight, "Condition") : "";
      // 📏 Height は MaxHeight の子が本形だが、Area 直下の形にも備える
      const maxHeight = childOf(area, "MaxHeight");
      const height =
        (maxHeight ? childOf(maxHeight, "Height") : undefined) ?? childOf(area, "Height");
      areas.push({
        name,
        grade,
        // 📌 P2P 経路と同じく到達時刻は "HH:MM" 表記にする
        arrivalLabel: arrival ? arrival.slice(11, 16) : null,
        firstHeightCondition: condition || null,
        // 📏 予想高は description 属性 ("1m" 等) をラベルに、要素値を数値に
        maxHeightLabel: height?.attrs.description || null,
        maxHeightValue: height ? numOrNull(height.text.trim()) : null,
      });
    }
  }
  let grade = "Unknown";
  for (const a of areas) {
    if ((TSUNAMI_GRADE_RANK[a.grade] ?? 0) > (TSUNAMI_GRADE_RANK[grade] ?? 0)) grade = a.grade;
  }
  // 📌 解除の判定: 取消電文、または全区域が津波予報で見出し・標題に
  // 「解除」を含むもの。⚠️ 実電文での検証は残タスク
  const allForecast = areas.length > 0 && areas.every((a) => a.grade === "Forecast");
  const cancelled =
    parts.infoType === "取消" ||
    (allForecast && (parts.headlineText.includes("解除") || parts.controlTitle.includes("解除")));
  return {
    kind: "tsunami",
    // 📌 キーは発表時刻ベース (P2P の電文 ID とは一致しないため、ストア側で
    // 発表時刻+区域名による経路間の同一視を行う。store.ts 参照)
    key: `552:${time}`,
    time,
    grade,
    cancelled,
    areas,
  };
}

// ------------------------------------------
// 🎛 電文種別 → 変換先の対応 (Phase 2 の振り分け用)
// ------------------------------------------
export const DMDSS_TELEGRAM_TYPES = {
  eew: ["VXSE43", "VXSE45"],
  quake: ["VXSE51", "VXSE52", "VXSE53"],
  tsunami: ["VTSE41"],
} as const;
