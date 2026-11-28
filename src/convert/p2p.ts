// ==========================================
// 🔀 P2P地震情報の変換 (551 / 552 / 556)
// ==========================================
// 📌 P2P地震情報 API の履歴データ (JSON) を共通フォーマットへ変換する。
// 規則は Aegis ファミリー各実装 (Discord Bot の parseQuakes 等) と
// 一致させ、同じ地震が Bot 直読みと A.A.S 経由で同じ姿になるようにする。
// 表示向けの整形 (注目地点の照合・座標表によるプロット用座標付与など)
// は持たず、正規化に徹する。取得 (ポーリング) は Phase 2 の領分で、
// ここは純粋な変換だけを行う。
//   551 = 地震情報 (国外地震は issue.type="Foreign")
//   552 = 津波予報
//   556 = 緊急地震速報 (警報)
//   ※ 554 は「緊急地震速報 発表検出」のみで中身を持たないため使わない。
//   ※ 556 は国外地震情報ではない。
import { depthOrNull, eewBaseKey, haversineKm, numOrNull, roundedCoordKey } from "../util.js";
import type { EewDraft, QuakeDraft, TsunamiDraft } from "../types.js";

// ------------------------------------------
// 🌍 地震情報 (551)
// ------------------------------------------
// 📌 報の完全さの順位。詳細な報ほど大きく、主電文の選定に使う
const QUAKE_TYPE_RANK: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Foreign: 3,
  Destination: 2,
  ScalePrompt: 1,
};

// 📳 P2P の観測点 (原文の形)
interface QuakePoint {
  pref?: string;
  addr?: string;
  scale?: number;
  isArea?: boolean;
}

// 🌍 電文1件を内部レコードへ起こした形 (グルーピング・統合の入力)
interface QuakeRecord {
  rawId: string;
  time: string;
  issueTime: string;
  issueType: string;
  issueCorrect: string;
  typeRank: number;
  hypocenter: string;
  magnitude: number | null;
  depthKm: number | null;
  maxScale: number;
  tsunamiKind: string;
  // 🕐 eq.originTime (主に国外地震が持つ発生時刻の原表記)。無ければ null
  originTime: string | null;
  // 🌊 comments の原文 (freeFormComment 優先、無ければ text)。空は null
  tsunamiText: string | null;
  lat: number | null;
  lon: number | null;
  points: QuakePoint[];
}

// 🌍 P2P の地震電文1件を内部レコードに変換する
function parseQuakeRecord(item: any): QuakeRecord | null {
  const eq = item?.earthquake;
  if (!eq) return null;
  const hypo = eq.hypocenter ?? {};
  const magRaw = numOrNull(hypo.magnitude);
  const issueType = String(item.issue?.type ?? "");
  const issueCorrect = String(item.issue?.correct ?? "");
  const latRaw = numOrNull(hypo.latitude);
  const lonRaw = numOrNull(hypo.longitude);
  // 🌍 P2P は震源未確定時に -200 等の範囲外座標を入れることがあるため範囲外は無効にする
  const latOk = latRaw !== null && latRaw >= -90 && latRaw <= 90;
  const lonOk = lonRaw !== null && lonRaw >= -180 && lonRaw <= 180;
  // 🌊 コメントは freeFormComment があればそれを優先し、無ければ text を
  // 採用する。空文字は未設定とする
  const comments = item.comments ?? {};
  const nonEmptyString = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  return {
    rawId: String(item.id ?? ""),
    time: String(eq.time ?? item.time ?? ""),
    issueTime: String(item.issue?.time ?? item.time ?? ""),
    issueType,
    issueCorrect,
    typeRank: QUAKE_TYPE_RANK[issueType] ?? 0,
    hypocenter: String(hypo.name ?? "").trim(),
    magnitude: magRaw !== null && magRaw >= 0 ? magRaw : null,
    depthKm: depthOrNull(hypo.depth),
    maxScale: numOrNull(eq.maxScale) ?? -1,
    tsunamiKind: String(eq.domesticTsunami ?? "None"),
    originTime: nonEmptyString(eq.originTime),
    tsunamiText: nonEmptyString(comments.freeFormComment) ?? nonEmptyString(comments.text),
    lat: latOk && lonOk ? latRaw : null,
    lon: latOk && lonOk ? lonRaw : null,
    points: Array.isArray(item.points) ? item.points : [],
  };
}

// 🌍 同一地震の複数報を1件の地震イベントにまとめる
function buildQuakeEvent(records: QuakeRecord[]): QuakeDraft {
  // 🕐 完全な報 (種別ランク高) を主とし、同ランクでは発表時刻が新しいものを優先
  const sorted = [...records].sort(
    (a, b) => b.typeRank - a.typeRank || (a.issueTime < b.issueTime ? 1 : a.issueTime > b.issueTime ? -1 : 0),
  );
  const pick = <T,>(fn: (r: QuakeRecord) => T | null | undefined): T | null => {
    for (const r of sorted) {
      const v = fn(r);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const primary = sorted[0];
  const hypocenter = pick((r) => (r.hypocenter ? r.hypocenter : null)) ?? "不明";
  const lat = pick((r) => r.lat);
  const lon = pick((r) => r.lon);
  const maxScale = Math.max(...records.map((r) => r.maxScale));
  // 📳 観測点は全報分を統合し、同一地点は最大震度を残す
  const pointMap = new Map<string, QuakePoint & { scale: number }>();
  for (const r of records) {
    for (const pt of r.points) {
      const sc = numOrNull(pt.scale) ?? 0;
      const key = `${pt.pref ?? ""}|${pt.addr ?? ""}|${pt.isArea ? "area" : "point"}`;
      const prev = pointMap.get(key);
      if (!prev || sc > prev.scale) pointMap.set(key, { ...pt, scale: sc });
    }
  }
  const points = [...pointMap.values()].map((pt) => ({
    pref: String(pt.pref ?? ""),
    name: String(pt.addr ?? ""),
    scale: pt.scale,
    isArea: Boolean(pt.isArea),
  }));
  const atMax = points.filter((pt) => pt.scale === maxScale);
  const top = atMax.find((pt) => !pt.isArea) ?? atMax[0];
  const prefMax = new Map<string, number>();
  for (const pt of points) {
    if (!pt.pref) continue;
    prefMax.set(pt.pref, Math.max(prefMax.get(pt.pref) ?? 0, pt.scale));
  }
  const prefScales = [...prefMax.entries()]
    .map(([pref, scale]) => ({ pref, scale }))
    .sort((a, b) => b.scale - a.scale);
  // 🌍 同一性キーは震央座標 (小数1桁丸め) を優先し、座標が無い場合のみ震源名を使う。
  // 国外地震 (Foreign) は電文の time が発表時刻で続報ごとに変わるため、
  // 発生時刻 (originTime) をキーの時刻にする
  const coordKey = roundedCoordKey(lat, lon);
  const keyTime =
    primary.issueType === "Foreign" ? (pick((r) => r.originTime) ?? primary.time) : primary.time;
  const groupKey = keyTime
    ? `551:${keyTime}|${coordKey ? coordKey : hypocenter}`
    : `551:id:${primary.rawId}`;
  // 🌊 津波は確定した値を優先し、確認中しかなければ主報の値を残す
  const tsunamiKind =
    pick((r) => (r.tsunamiKind !== "Checking" && r.tsunamiKind !== "Unknown" ? r.tsunamiKind : null)) ??
    primary.tsunamiKind;
  return {
    kind: "quake",
    key: groupKey,
    telegramId: primary.rawId,
    time: primary.time,
    announcedTime: primary.issueTime,
    originTime: pick((r) => r.originTime),
    hypocenter,
    magnitude: pick((r) => r.magnitude),
    depthKm: pick((r) => r.depthKm),
    maxScale,
    tsunamiKind,
    tsunamiText: pick((r) => r.tsunamiText),
    foreign: primary.issueType === "Foreign",
    issueType: primary.issueType,
    issueCorrect: primary.issueCorrect,
    lat,
    lon,
    topPoint: top ? top.name || top.pref || null : null,
    topPointIsArea: top ? top.isArea : false,
    prefScales,
    points,
  };
}

// 🌍 グルーピングで同一視に使う時刻。国外地震 (Foreign) の電文 time は
// 発表時刻で続報ごとに変わるため、発生時刻 (originTime) で同一視する。
// 国内電文は time (発生時刻)
function groupingTime(r: QuakeRecord): string {
  return r.issueType === "Foreign" && r.originTime ? r.originTime : r.time;
}

// 🌍 P2P の地震履歴を地震イベントの一覧に変換する (複数報はグルーピングして統合する)
export function parseQuakes(data: unknown): QuakeDraft[] {
  if (!Array.isArray(data)) return [];
  const groups: { records: QuakeRecord[] }[] = [];
  for (const item of data) {
    const rec = parseQuakeRecord(item);
    if (!rec) continue;
    // 🌍 グルーピング: 同一視時刻が一致し、かつ (震源名が一致 / 一方が震源名なし /
    // 震央座標が 50km 以内で近接) する既存グループへ寄せる
    const group =
      groups.find((g) => {
        const head = g.records[0];
        if (groupingTime(head) !== groupingTime(rec)) return false;
        if (!head.hypocenter || !rec.hypocenter) return true;
        if (head.hypocenter === rec.hypocenter) return true;
        if (head.lat !== null && head.lon !== null && rec.lat !== null && rec.lon !== null) {
          return haversineKm(head.lat, head.lon, rec.lat, rec.lon) <= 50;
        }
        return false;
      }) ?? (() => {
        const g = { records: [] as QuakeRecord[] };
        groups.push(g);
        return g;
      })();
    group.records.push(rec);
  }
  return groups
    .map((g) => buildQuakeEvent(g.records))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// ------------------------------------------
// 🌊 津波予報 (552)
// ------------------------------------------
// 📌 グレードの順位 (最上位グレードの判定用)
const GRADE_RANK: Record<string, number> = { MajorWarning: 3, Warning: 2, Watch: 1 };

// 🌊 P2P の津波電文を津波イベントの一覧に変換する
export function parseTsunamis(data: unknown): TsunamiDraft[] {
  if (!Array.isArray(data)) return [];
  const out: TsunamiDraft[] = [];
  for (const item of data) {
    const areasRaw: Record<string, any>[] = Array.isArray(item?.areas) ? item.areas : [];
    const areas = areasRaw.map((a) => {
      const at = typeof a?.firstHeight?.arrivalTime === "string" ? a.firstHeight.arrivalTime : null;
      return {
        name: String(a?.name ?? ""),
        grade: String(a?.grade ?? ""),
        maxHeightLabel: typeof a?.maxHeight?.description === "string" ? a.maxHeight.description : null,
        maxHeightValue: numOrNull(a?.maxHeight?.value),
        arrivalLabel: at && at.length >= 16 ? at.slice(11, 16) : at,
        firstHeightCondition:
          typeof a?.firstHeight?.condition === "string" && a.firstHeight.condition
            ? a.firstHeight.condition
            : null,
      };
    });
    let grade = "Unknown";
    for (const a of areas) {
      if ((GRADE_RANK[a.grade] ?? 0) > (GRADE_RANK[grade] ?? 0)) grade = a.grade;
    }
    const id = String(item?.id ?? "");
    out.push({
      kind: "tsunami",
      key: `552:${id}`,
      time: String(item?.time ?? ""),
      cancelled: Boolean(item?.cancelled),
      grade,
      areas,
    });
  }
  return out;
}

// ------------------------------------------
// 🚨 緊急地震速報 (警報) (556)
// ------------------------------------------
// 🚨 P2P 556 の実形式:
// - 取消は cancelled (旧形式の isCancel も後方互換で受ける)
// - areas[] は scaleFrom / scaleTo (scaleTo=99 は「〜程度以上」)。
//   その地域の予想震度は scaleFrom (下限) を採用し、全体の推定最大震度は
//   scaleFrom の最大値とする。earthquake に maxScale は無い
// - arrivalTime は null あり
// - earthquake.condition が「仮定震源要素」を含めば isAssumption
// - issue は {time, eventId, serial}、由来の EEW は常に警報 (isWarn=true)
export function parseEews(data: unknown): EewDraft[] {
  if (!Array.isArray(data)) return [];
  const out: EewDraft[] = [];
  for (const item of data) {
    const eq = item?.earthquake;
    if (!eq) continue; // プレースホルダは採用しない
    const hypo = eq.hypocenter ?? {};
    const hypoName = String(hypo.name ?? "不明");
    const cancel = Boolean(item.cancelled ?? item.isCancel);
    const magRaw = numOrNull(hypo.magnitude);
    const lat = numOrNull(hypo.latitude);
    const lon = numOrNull(hypo.longitude);
    const latOk = lat !== null && lat >= -90 && lat <= 90 ? lat : null;
    const lonOk = lon !== null && lon >= -180 && lon <= 180 ? lon : null;
    const prefs: string[] = [];
    const areaArrivals: { pref: string; arrivalTime: string }[] = [];
    const areaScales: { pref: string; name: string; scale: number; scaleTo: number | null }[] = [];
    for (const a of Array.isArray(item.areas) ? item.areas : []) {
      if (a?.pref && !prefs.includes(a.pref)) {
        if (prefs.length < 6) prefs.push(a.pref);
      }
      if (a?.pref && typeof a?.arrivalTime === "string") {
        areaArrivals.push({ pref: a.pref, arrivalTime: a.arrivalTime });
      }
      // 📌 556 の実形式は scaleFrom、従来形式は scale。scaleFrom を優先する
      const sc = numOrNull(a?.scaleFrom) ?? numOrNull(a?.scale);
      if (a?.pref && sc !== null) {
        // 📳 上限 (scaleTo) も取り込む。99 は「〜程度以上」(下限のみ判明)。
        // 従来形式に scaleTo が無ければ null (上限不明) とする
        areaScales.push({
          pref: String(a.pref),
          name: String(a.name ?? a.pref),
          scale: sc,
          scaleTo: numOrNull(a?.scaleTo),
        });
      }
    }
    // 📳 推定最大震度: 従来形式の maxScale があればそれを使い、無ければ
    // areas の scaleFrom の最大値 (地域が無ければ不明センチネル -1)
    const maxScaleRaw = numOrNull(eq.maxScale);
    const estScale =
      maxScaleRaw !== null
        ? maxScaleRaw
        : areaScales.length > 0
          ? Math.max(...areaScales.map((a) => a.scale))
          : -1;
    const serialRaw = numOrNull(item.issue?.serial);
    const eventIdRaw = item.issue?.eventId;
    const eventId =
      typeof eventIdRaw === "string" && eventIdRaw !== ""
        ? eventIdRaw
        : typeof eventIdRaw === "number"
          ? String(eventIdRaw)
          : null;
    // 📍 同一視キー: JMA イベント ID を優先し、無い場合のみ発生時刻+座標の
    // 従来規則へフォールバックする (util.eewBaseKey)
    const coordKey = roundedCoordKey(latOk, lonOk);
    const origin = String(eq.originTime ?? item.time ?? "");
    const baseKey = eewBaseKey(eventId, origin, coordKey, hypoName);
    out.push({
      kind: "eew",
      key: baseKey + (cancel ? "-cancel" : ""),
      baseKey,
      time: String(item.time ?? ""),
      originTime: origin,
      cancel,
      // 🚨 P2P 556 は緊急地震速報 (警報) の本体のため、由来の EEW は常に警報
      isWarn: true,
      // 📌 最終報の概念は 556 には無いため常に false (Wolfx 由来のみ true になりうる)
      isFinal: false,
      serial: serialRaw !== null ? Math.trunc(serialRaw) : null,
      eventId,
      isAssumption: String(eq.condition ?? "").includes("仮定震源要素"),
      hypocenter: hypoName,
      estScale,
      estMagnitude: magRaw !== null && magRaw >= 0 ? magRaw : null,
      prefs,
      lat: latOk,
      lon: lonOk,
      depthKm: depthOrNull(hypo.depth),
      areaArrivals,
      areaScales,
    });
  }
  return out;
}
