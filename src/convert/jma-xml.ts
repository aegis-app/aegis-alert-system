// ==========================================
// 🔀 気象庁防災情報XML の変換 (フィード分類と電文)
// ==========================================
// 📌 気象庁が公開する Atom フィード (随時 / 地震火山) の entry を、
// リンク先 URL のファイル名に含まれるデータ種類コードで分類し、対象
// ドメインの電文 XML (Control / Head / Body) を共通フォーマットへ
// 変換する。対象は電文系ドメイン: 指定河川洪水予報 (VXKO**) /
// 土砂災害警戒情報 (VXWW50) / 竜巻注意情報 (VPHW50・51) / 記録的
// 短時間大雨情報 (VPOA50) / 顕著な大雨に関する情報 (VPZJ50・VPCJ50・
// VPFJ50 の一部) / 火山系 (VFVO**)。
// 取得と既読管理は Phase 2 の領分で、ここは純粋な変換だけを行う。
import {
  bodyTextOf,
  childOf,
  childText,
  descendants,
  firstDescendant,
  joinTexts,
  parseTelegramParts,
  parseXml,
  toHalfDigits,
  type XmlNode,
} from "./xml.js";
import type {
  FloodDraft,
  FloodStation,
  LinearRainDraft,
  RecordRainDraft,
  SedimentDraft,
  TornadoDraft,
  VolcanoCategory,
  VolcanoDraft,
} from "../types.js";

// ------------------------------------------
// 📰 Atom フィードの解析と電文の分類
// ------------------------------------------
// 📰 フィードの entry 1件分
export interface FeedEntry {
  // 🆔 entry の <id> (気象庁フィードでは電文 URL そのもの)。既読管理の軸
  id: string;
  // 📢 entry の <title> (電文の情報名称)
  title: string;
  // 🔗 電文 XML の URL (link の href)
  url: string;
  // 🏷️ URL のファイル名から取り出したデータ種類コード (例 VXKO50)
  code: string;
  // 🕐 entry の <updated> (ISO 8601)
  updated: string;
}

// 🏷️ URL のファイル名からデータ種類コードを取り出す
// (ファイル名は "<日時>_<版>_<コード>_<官署コード>.xml" の形式)
export function extractDataCode(url: string): string {
  const base = url.split("/").pop() ?? "";
  const m = /_(V[A-Z]{3}\d{2})_/.exec(base) ?? /(V[A-Z]{3}\d{2})/.exec(base);
  return m ? m[1] : "";
}

// 📰 Atom フィード XML を entry 一覧へ変換する
export function parseFeedEntries(xml: string): FeedEntry[] {
  const root = parseXml(xml);
  if (!root) return [];
  const out: FeedEntry[] = [];
  for (const entry of descendants(root, "entry")) {
    const id = childText(entry, "id");
    const link = childOf(entry, "link");
    const url = link?.attrs.href ?? id;
    if (!id || !url) continue;
    out.push({
      id,
      title: childText(entry, "title"),
      url,
      code: extractDataCode(url),
      updated: childText(entry, "updated"),
    });
  }
  return out;
}

// 📌 電文コード → 取り込み対象の分類。"linear-rain-candidate" は気象情報
// 電文であり、本文の標題・見出しを確認するまで取り込むか決まらない
export type JmaXmlClass =
  | "flood"
  | "sediment"
  | "tornado"
  | "record-rain"
  | "linear-rain-candidate"
  | "volcano"
  | null;

// 🏷️ データ種類コードを分類する。対象外コードは null (本文を取得しない)
export function classifyDataCode(code: string): JmaXmlClass {
  const vxko = /^VXKO(\d{2})$/.exec(code);
  if (vxko) {
    const ii = Number(vxko[1]);
    return ii >= 50 && ii <= 89 ? "flood" : null;
  }
  if (code === "VXWW50") return "sediment";
  if (code === "VPHW50" || code === "VPHW51") return "tornado";
  if (code === "VPOA50") return "record-rain";
  if (code === "VPZJ50" || code === "VPCJ50" || code === "VPFJ50") return "linear-rain-candidate";
  if (/^VFVO\d{2}$/.test(code)) return "volcano";
  return null;
}

// ------------------------------------------
// 🌊 指定河川洪水予報 (VXKO**) の変換
// ------------------------------------------
// 📌 種別コード (気象庁「洪水予報 XML の解説」表1) から重要度を決める:
// 10=解除 / 20・21・22=氾濫注意情報 / 30・31=氾濫警戒情報 /
// 40・41=氾濫危険情報 / 51・53=氾濫発生情報。新標題 (レベル２
// 氾濫注意報 等) でもコードの段階は同じため、コード優先で判定し、
// コードが読めない場合のみ種別名から推定する
export function floodSeverity(categoryCode: string, category: string): number {
  switch (categoryCode) {
    case "10": return 0;
    case "20": case "21": case "22": return 2;
    case "30": case "31": return 3;
    case "40": case "41": return 4;
    case "51": case "53": return 5;
    default: break;
  }
  if (category.includes("発生")) return 5;
  if (category.includes("危険")) return 4;
  if (category.includes("警戒")) return 3;
  if (category.includes("注意")) return 2;
  if (category.includes("解除")) return 0;
  return 1;
}

// 🌊 水位・流量情報から観測所ごとの現況水位を取り出す。TimeSeriesInfo の
// TimeDefine で Name が「現況」の refID を引き、WaterLevel (type="水位")
// のうちその refID のものを現況とする (無ければ先頭の水位)
function floodWaterLevels(body: XmlNode): Map<string, { level: string; condition: string | null }> {
  const out = new Map<string, { level: string; condition: string | null }>();
  for (const tsi of descendants(body, "TimeSeriesInfo")) {
    let currentRef: string | null = null;
    for (const td of descendants(tsi, "TimeDefine")) {
      if (childText(td, "Name") === "現況" && td.attrs.timeId) currentRef = td.attrs.timeId;
    }
    for (const item of tsi.children.filter((c) => c.name === "Item")) {
      const station = childOf(item, "Station");
      const name = station ? childText(station, "Name") : "";
      if (!name || out.has(name)) continue;
      const levels = descendants(item, "WaterLevel").filter((w) => w.attrs.type === "水位");
      if (levels.length === 0) continue;
      const cur = levels.find((w) => currentRef !== null && w.attrs.refID === currentRef) ?? levels[0];
      out.set(name, { level: cur.text.trim(), condition: cur.attrs.condition ?? null });
    }
  }
  return out;
}

// 🌊 洪水予報電文を下書きへ変換する。必須部 (標題・発表日時・予報区域)
// が読めなければ null
export function parseFloodTelegram(xml: string): FloodDraft | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.reportDateTime) return null;
  // 📌 予報区域の Information が種別と区域名の正本 (解説の構成どおり)
  const areaInfo =
    t.headlineInfos.find((i) => i.type.includes("予報区域")) ?? t.headlineInfos[0];
  const areaItem = areaInfo?.items[0];
  const area = areaItem?.areas[0]?.name ?? "";
  const category = areaItem?.kindName ?? "";
  if (!area || !category) return null;
  const riverInfo = t.headlineInfos.find((i) => i.type === "指定河川洪水予報（河川）");
  const rivers = riverInfo
    ? [...new Set(riverInfo.items.flatMap((it) => it.areas.map((a) => a.name)))]
    : [];
  const river = rivers[0] ?? area;
  const office = t.publishingOffice || t.editorialOffice;
  // 📍 観測所: 主文 Item の Stations を正とし、水位情報の現況を突き合わせる
  const stations: FloodStation[] = [];
  const seenStation = new Set<string>();
  const levels = t.body ? floodWaterLevels(t.body) : new Map<string, { level: string; condition: string | null }>();
  if (t.body) {
    for (const st of descendants(t.body, "Station")) {
      const name = childText(st, "Name");
      if (!name || seenStation.has(name)) continue;
      seenStation.add(name);
      const lv = levels.get(name);
      stations.push({ name, waterLevel: lv?.level ?? null, condition: lv?.condition ?? null });
    }
  }
  const categoryCode = areaItem?.kindCode ?? "";
  return {
    kind: "flood",
    key: `flood:${office}:${river}:${area}`,
    office,
    river,
    rivers: rivers.length > 0 ? rivers : [river],
    area,
    category,
    categoryCode,
    severity: floodSeverity(categoryCode, category),
    // 📌 解除は種別コード 10、または種別名が「〜解除」で終わる形
    // (「氾濫注意情報 (警戒情報解除)」は格下げであり解除ではない)
    cancelled: categoryCode === "10" || /解除$/.test(category),
    reportDatetime: t.reportDateTime,
    time: t.reportDateTime,
    title: t.headTitle,
    headline: t.headlineText,
    text: bodyTextOf(t.body),
    stations,
  };
}

// ------------------------------------------
// 🏔️ 土砂災害警戒情報 (VXWW50) の変換
// ------------------------------------------
// 📌 完全集合型: Body/Warning が都道府県内の全市町村を列挙し、各 Item の
// Kind が 警戒 / 解除 / なし を示す。Headline の Information は差分
// (今回変わった市町村) のみのため集合の正本には使わない。ここでは
// 「現在警戒中の市町村」の下書き一覧と、差分計算のスコープになる
// 都道府県名を返す。警戒中が0件 (全解除) でも都道府県名は返し、
// スナップショット側で解除を生成できるようにする
export interface SedimentTelegram {
  prefName: string;
  drafts: SedimentDraft[];
}

// 🏔️ 土砂災害警戒情報の電文を、有効集合の下書き一覧 + スコープへ変換する
export function parseSedimentTelegram(xml: string): SedimentTelegram | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.body || !t.reportDateTime) return null;
  const targetArea = firstDescendant(t.body, "TargetArea");
  const prefName = targetArea ? childText(targetArea, "Name") : "";
  if (!prefName) return null;
  const warning = firstDescendant(t.body, "Warning");
  const drafts: SedimentDraft[] = [];
  if (warning) {
    for (const item of warning.children.filter((c) => c.name === "Item")) {
      const kind = childOf(item, "Kind");
      const kindName = kind ? childText(kind, "Name") : "";
      if (kindName !== "警戒") continue; // 📌 警戒中のみが有効集合の要素
      const areaNode = childOf(item, "Area");
      const cityName = areaNode ? childText(areaNode, "Name") : "";
      if (!cityName) continue;
      drafts.push({
        kind: "sediment",
        key: `sediment:${prefName}:${cityName}`,
        prefName,
        cityName,
        reportDatetime: t.reportDateTime,
        time: t.reportDateTime,
        headline: t.headlineText,
        released: false,
      });
    }
  }
  return { prefName, drafts };
}

// ------------------------------------------
// 🌪️ 竜巻注意情報 (VPHW50 / VPHW51) の変換
// ------------------------------------------
export function parseTornadoTelegram(xml: string, code: string): TornadoDraft | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.reportDateTime) return null;
  // 🏢 発表官署は技術情報により PublishingOffice が「気象庁」に統一される
  // ため、実編集官署である EditorialOffice を軸にする
  const office = t.editorialOffice || t.publishingOffice;
  if (!office) return null;
  // 📍 対象地域は Headline の最初の Information (発表細分) の Areas
  const areas = t.headlineInfos[0]
    ? [...new Set(t.headlineInfos[0].items.flatMap((it) => it.areas.map((a) => a.name)))]
    : [];
  return {
    kind: "tornado",
    key: `tornado:${office}:${t.reportDateTime}`,
    office,
    areas,
    reportDatetime: t.reportDateTime,
    time: t.reportDateTime,
    validUntil: t.validDateTime,
    headline: t.headlineText,
    text: bodyTextOf(t.body),
    // 👀 目撃情報付きはコード VPHW51 (標題にも「目撃情報付き」が入る)
    witnessed: code === "VPHW51" || t.controlTitle.includes("目撃"),
  };
}

// ------------------------------------------
// 🌧️ 記録的短時間大雨情報 (VPOA50) の変換
// ------------------------------------------
// 📌 雨量は見出し文の定型から抽出する。文面の区別: 観測 (アメダス等) は
// 「<地点>で<数値>ミリ」、解析雨量は「<地点>付近で約<数値>ミリ」と
// 「付近」「約」が付く
export function parseRecordRainTelegram(xml: string): RecordRainDraft | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.reportDateTime) return null;
  const office = t.editorialOffice || t.publishingOffice;
  if (!office) return null;
  const areas = t.headlineInfos[0]
    ? [...new Set(t.headlineInfos[0].items.flatMap((it) => it.areas.map((a) => a.name)))]
    : [];
  let station: string | null = null;
  let rainfallMm: number | null = null;
  let rainfallLabel: string | null = null;
  let rainfallType: RecordRainDraft["rainfallType"] = null;
  const m = /([^\s　]+?)で(約)?([０-９0-9]+)\s*ミリ/.exec(t.headlineText);
  if (m) {
    station = m[1];
    rainfallMm = Number(toHalfDigits(m[3]));
    if (!Number.isFinite(rainfallMm)) rainfallMm = null;
    rainfallLabel = `${m[2] ?? ""}${m[3]}ミリ`;
    rainfallType = station.endsWith("付近") || m[2] ? "analysis" : "observed";
  }
  return {
    kind: "record-rain",
    key: `record-rain:${office}:${t.reportDateTime}`,
    office,
    areas,
    station,
    rainfallMm,
    rainfallLabel,
    rainfallType,
    reportDatetime: t.reportDateTime,
    time: t.reportDateTime,
    headline: t.headlineText,
    text: bodyTextOf(t.body),
  };
}

// ------------------------------------------
// 🌧️ 顕著な大雨に関する情報 (線状降水帯) の変換
// ------------------------------------------
// 📌 気象情報電文 (VPZJ50 / VPCJ50 / VPFJ50) のうち、標題が
// 「顕著な大雨に関する〜」のもの、または見出しに「顕著な大雨に関する」
// を含むものだけが対象。それ以外は null を返し取り込まない
export function parseLinearRainTelegram(xml: string): LinearRainDraft | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.reportDateTime) return null;
  if (!t.headTitle.includes("顕著な大雨") && !t.headlineText.includes("顕著な大雨に関する")) {
    return null;
  }
  const office = t.publishingOffice || t.editorialOffice;
  if (!office) return null;
  const areas = t.headlineInfos[0]
    ? [...new Set(t.headlineInfos[0].items.flatMap((it) => it.areas.map((a) => a.name)))]
    : [];
  return {
    kind: "linear-rain",
    key: `linear-rain:${office}:${t.reportDateTime}`,
    office,
    title: t.headTitle,
    areas,
    reportDatetime: t.reportDateTime,
    time: t.reportDateTime,
    headline: t.headlineText,
    text: bodyTextOf(t.body),
  };
}

// ------------------------------------------
// 🌋 火山系 (VFVO**) の変換
// ------------------------------------------
// 📌 分類は Control/Title から判別する (電文対応: VFVO56=噴火速報 /
// VFVO50=噴火警報・予報 / VFVO53・54・55=降灰予報 / VFVO51=解説情報 /
// VFVO52=観測報)。コードより標題の方が利用者向けの分類として安定する
// ため標題を正とし、読めない場合はコードで補う
export function volcanoCategory(controlTitle: string, code: string): VolcanoCategory {
  if (controlTitle.includes("噴火速報")) return "噴火速報";
  if (controlTitle.includes("噴火警報") || controlTitle.includes("噴火予報")) return "噴火警報・予報";
  if (controlTitle.includes("降灰予報")) return "降灰予報";
  if (controlTitle.includes("解説情報")) return "解説情報";
  if (controlTitle.includes("観測報")) return "観測報";
  switch (code) {
    case "VFVO56": return "噴火速報";
    case "VFVO50": return "噴火警報・予報";
    case "VFVO53": case "VFVO54": case "VFVO55": return "降灰予報";
    case "VFVO51": return "解説情報";
    case "VFVO52": return "観測報";
    default: return "その他";
  }
}

// 🌋 噴火警戒レベルを抽出する。対象火山の Kind 名 (「レベル３
// (入山規制)」) を優先し、無ければ見出し・標題の
// 「噴火警戒レベル３(火口周辺規制)」表記から取る
function volcanoLevel(
  body: XmlNode | null,
  headline: string,
  title: string,
): { level: number | null; levelName: string | null } {
  const re = /レベル\s*([1-5１-５])\s*(?:（([^）]+)）)?/;
  if (body) {
    for (const kind of descendants(body, "Kind")) {
      const m = re.exec(childText(kind, "Name"));
      if (m) {
        return { level: Number(toHalfDigits(m[1])), levelName: m[2] ?? null };
      }
    }
  }
  const m = re.exec(headline) ?? re.exec(title);
  if (m) return { level: Number(toHalfDigits(m[1])), levelName: m[2] ?? null };
  return { level: null, levelName: null };
}

// 🌋 火山系電文を下書きへ変換する。火山名が読めなければ null
export function parseVolcanoTelegram(xml: string, code: string): VolcanoDraft | null {
  const t = parseTelegramParts(xml);
  if (!t || !t.body || !t.reportDateTime) return null;
  // 🌋 火山名は Areas (codeType="火山名") の Area が正本 (実電文で確認)
  let volcanoName = "";
  const cityAreas: string[] = [];
  for (const areasNode of descendants(t.body, "Areas")) {
    const codeType = areasNode.attrs.codeType ?? "";
    const names = areasNode.children
      .filter((c) => c.name === "Area")
      .map((a) => childText(a, "Name"))
      .filter(Boolean);
    if (codeType === "火山名" && !volcanoName && names.length > 0) volcanoName = names[0];
    if (codeType.includes("市町村")) {
      for (const nm of names) if (!cityAreas.includes(nm)) cityAreas.push(nm);
    }
  }
  if (!volcanoName) return null;
  const { level, levelName } = volcanoLevel(t.body, t.headlineText, t.headTitle);
  // 📝 本文は火山系 Body の本文要素 (Text のほか VolcanoActivity 等の
  // 平文要素) を連結する
  const textParts = [
    ...descendants(t.body, "Text"),
    ...descendants(t.body, "VolcanoHeadline"),
    ...descendants(t.body, "VolcanoActivity"),
    ...descendants(t.body, "VolcanoPrevention"),
    ...descendants(t.body, "OtherObservation"),
  ];
  const category = volcanoCategory(t.controlTitle, code);
  return {
    kind: "volcano",
    key: `volcano:${volcanoName}:${category}:${t.reportDateTime}`,
    volcanoName,
    category,
    level,
    levelName,
    areas: cityAreas.filter((a) => a !== volcanoName),
    reportDatetime: t.reportDateTime,
    time: t.reportDateTime,
    title: t.headTitle,
    headline: t.headlineText,
    text: joinTexts(textParts),
  };
}
