// ==========================================
// 🔀 川の防災情報の変換 (水位・雨量・ダム)
// ==========================================
// 📌 国土交通省「川の防災情報」(https://www.river.go.jp/) のサイト内部
// JSON を共通フォーマットへ変換する。公式 API ではないため、取得間隔は
// 元データの10分粒度に合わせる (取得は Phase 2 の領分で、ここは純粋な
// 変換と URL の組み立てだけを行う)。
// ⚠️ 値は速報値 (未精査) で異常値を含み得る。出典: 国土交通省 川の防災情報。
//
// 🔍 URL 仕様 (サイトの JS バンドルと実レスポンスで確認):
// - 現在観測時刻: <system>/tmCrntTime.json → {"crntObsTime":"2026/11/26 11:25"}
// - 水系一覧 (都道府県別): <files>/obslist/idx/rsys/pref/<県コード>.json
// - 水系内の河川一覧: <files>/obslist/idx/rsys/rsys/<水系コード>.json
// - 観測所マスタ (河川別): <files>/obslist/obs/rvrlist/<河川コード>.json
//   obsStg には基準水位 (rsrvStg=水防団待機 / warnStg=氾濫注意 /
//   spclWarnStg=避難判断 / dngStg=氾濫危険 / fldStg=氾濫発生) が入る
// - 現在値 (水系別の一括): <files>/obslist/tm/rsyslist/<YYYYMMDD>/<HHmm>/<水系コード>.json
//   HHmm は crntObsTime を10分単位に切り捨てたもの
// 📌 全国一括で現在値を取れる口は無い。水系単位の一括 (rsyslist) が
// 最も粗い取得単位。観測所数の実数: 水位 約6,900 + 雨量 約6,800 +
// ダム 約870 (ストアの種別 cap はこの実数に基づく。store.ts 参照)
import { numOrNull } from "../util.js";
import type { DamDraft, RiverDraft, RiverLevelState } from "../types.js";

// 🌐 JSON 配置ベース (files: 観測データ系 / system: 現在時刻系)
export const KAWABOU_FILES_BASE = "https://www.river.go.jp/kawabou/file/files";
export const KAWABOU_SYSTEM_BASE = "https://www.river.go.jp/kawabou/file/system";

// ------------------------------------------
// 🌐 URL ビルダー
// ------------------------------------------
export function buildTmCrntTimeUrl(): string {
  return `${KAWABOU_SYSTEM_BASE}/tmCrntTime.json`;
}

export function buildPrefRsysIndexUrl(prefCode: number): string {
  return `${KAWABOU_FILES_BASE}/obslist/idx/rsys/pref/${prefCode}.json`;
}

export function buildRsysIndexUrl(rsysCode: number): string {
  return `${KAWABOU_FILES_BASE}/obslist/idx/rsys/rsys/${rsysCode}.json`;
}

export function buildRvrMasterUrl(riverCode: number): string {
  return `${KAWABOU_FILES_BASE}/obslist/obs/rvrlist/${riverCode}.json`;
}

export function buildRsysTmListUrl(datePath: string, rsysCode: number): string {
  return `${KAWABOU_FILES_BASE}/obslist/tm/rsyslist/${datePath}${rsysCode}.json`;
}

// 📍 川防の都道府県コード (生成規則: 北海道は地方別に 101〜105、
// 他県は都道府県番号 (2〜47) ×100+1)
export const KAWABOU_PREF_CODES: readonly number[] = [
  101, 102, 103, 104, 105,
  ...Array.from({ length: 46 }, (_, i) => (i + 2) * 100 + 1),
];

// 🕐 現在観測時刻 ("2026/11/26 11:25") から rsyslist の日付パス
// ("20261126/1120/") を作る。分は10分単位に切り捨てる (ファイルは
// 10分粒度で生成されるため)。読めない表記では例外にする (呼び出し側で
// ポーリング全体の失敗として扱い、前回状態を保持する)
export function kawabouDatePath(crntObsTime: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/.exec(crntObsTime ?? "");
  if (!m) throw new Error(`現在観測時刻を読めませんでした: ${crntObsTime}`);
  const minute = Math.floor(Number(m[5]) / 10) * 10;
  return `${m[1]}${m[2]}${m[3]}/${m[4]}${String(minute).padStart(2, "0")}/`;
}

// ------------------------------------------
// 📏 状態の導出 (水位)
// ------------------------------------------
// 📌 テレメータ tmStg の欠測コード (stgCcd): サイトのアイコン判定でも
// 「null または 128 以上は欠測」とされており (実データでも欠測局は
// 140/160/190 等、正常局は 0)、この規則を欠測判定の正とする
export function isMissingCode(ccd: unknown): boolean {
  const n = numOrNull(ccd);
  return n === null || n >= 128;
}

// 📌 値の有効性: 欠測コードでない場合のみ数値を採用する (欠測局は
// 値フィールドに 0 等のプレースホルダが入るため、そのまま使うと
// 「水位 0m の平常」に化けてしまう)
function valueOrNull(v: unknown, ccd: unknown): number | null {
  if (isMissingCode(ccd)) return null;
  return numOrNull(v);
}

// 📏 超過レベルコード (stgOvlvl) → 状態。サイトのアイコン判定で確認
// した対応: 90=氾濫発生 / 70・80=氾濫危険 / 50・60=避難判断 /
// 20・30・40=氾濫注意 / 10=水防団待機 / 0=平常 (十の位が段階、一の位は
// 同段階内の細分)。欠測コードが立っていれば超過コードより欠測を優先
// する (欠測局にも超過コードのプレースホルダが入りうるため)
export function levelStateFromTm(tmStg: Record<string, any>): {
  levelState: RiverLevelState;
  stateSeverity: number;
} {
  if (isMissingCode(tmStg?.stgCcd)) return { levelState: "欠測", stateSeverity: -1 };
  const ovlvl = numOrNull(tmStg?.stgOvlvl);
  if (ovlvl !== null) {
    if (ovlvl >= 90) return { levelState: "氾濫発生水位超過", stateSeverity: 5 };
    if (ovlvl >= 70) return { levelState: "氾濫危険水位超過", stateSeverity: 4 };
    if (ovlvl >= 50) return { levelState: "避難判断水位超過", stateSeverity: 3 };
    if (ovlvl >= 20) return { levelState: "氾濫注意水位超過", stateSeverity: 2 };
    if (ovlvl >= 10) return { levelState: "水防団待機水位超過", stateSeverity: 1 };
    return { levelState: "平常", stateSeverity: 0 };
  }
  // 📌 超過コードが無いデータでは基準水位との比較で代替する
  const stg = numOrNull(tmStg?.stg);
  const master = tmStg?.__master as StationMaster | undefined;
  if (stg !== null && master?.thresholds) {
    const t = master.thresholds;
    if (t.flood !== null && stg >= t.flood) return { levelState: "氾濫発生水位超過", stateSeverity: 5 };
    if (t.danger !== null && stg >= t.danger) return { levelState: "氾濫危険水位超過", stateSeverity: 4 };
    if (t.refuge !== null && stg >= t.refuge) return { levelState: "避難判断水位超過", stateSeverity: 3 };
    if (t.caution !== null && stg >= t.caution) return { levelState: "氾濫注意水位超過", stateSeverity: 2 };
    if (t.standby !== null && stg >= t.standby) return { levelState: "水防団待機水位超過", stateSeverity: 1 };
  }
  return { levelState: "平常", stateSeverity: 0 };
}

// ------------------------------------------
// 📍 観測所マスタ (河川別の rvrlist) の変換
// ------------------------------------------
// 📍 観測所1件分のマスタ
export interface StationMaster {
  // 📍 観測所名
  name: string;
  // 📏 基準水位 (水位観測所のみ。それ以外は null)
  thresholds: RiverDraft["thresholds"] | null;
}

// 📍 河川1件分の観測所マスタ (種別ごとの対応表)
export interface RiverMaster {
  stg: Map<string, StationMaster>;
  rn: Map<string, StationMaster>;
  dam: Map<string, StationMaster>;
}

// 📏 基準水位が全て未設定の形 (マスタ未解決・雨量観測所用)
const EMPTY_THRESHOLDS: RiverDraft["thresholds"] = {
  standby: null,
  caution: null,
  refuge: null,
  danger: null,
  flood: null,
};

// 📍 rvrlist の1河川分を観測所コード → マスタ の対応に変換する
export function parseRvrMaster(data: unknown): RiverMaster {
  const out: RiverMaster = { stg: new Map(), rn: new Map(), dam: new Map() };
  if (!data || typeof data !== "object") return out;
  const obsList = (data as Record<string, any>).obsList;
  if (!obsList || typeof obsList !== "object") return out;
  const fill = (list: unknown, map: Map<string, StationMaster>, withThresholds: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const el of list) {
      const code = String(el?.obsFcd ?? "");
      const name = typeof el?.obsNm === "string" ? el.obsNm : "";
      if (!code || !name) continue;
      map.set(code, {
        name,
        thresholds: withThresholds
          ? {
              standby: numOrNull(el.rsrvStg),
              caution: numOrNull(el.warnStg),
              refuge: numOrNull(el.spclWarnStg),
              danger: numOrNull(el.dngStg),
              flood: numOrNull(el.fldStg),
            }
          : null,
      });
    }
  };
  fill(obsList.obsStg, out.stg, true);
  fill(obsList.obsRn, out.rn, false);
  fill(obsList.obsDam, out.dam, false);
  return out;
}

// 📍 水系インデックス (idx/rsys/rsys) から水系名と河川名の対応を取り出す
export function parseRsysIndex(data: unknown): { systemName: string; riverNames: Map<number, string> } {
  const riverNames = new Map<number, string>();
  let systemName = "";
  if (data && typeof data === "object") {
    const root = data as Record<string, any>;
    if (typeof root.rsysNm === "string") systemName = root.rsysNm;
    if (Array.isArray(root.rvrInfo)) {
      for (const r of root.rvrInfo) {
        const cd = numOrNull(r?.rvrCd);
        if (cd !== null && typeof r?.rvrNm === "string" && r.rvrNm) riverNames.set(cd, r.rvrNm);
      }
    }
  }
  return { systemName, riverNames };
}

// ------------------------------------------
// 🏞️ 現在値 (水系別の rsyslist) の変換
// ------------------------------------------
// 📥 変換の文脈 (水系インデックスと観測所マスタから解決した名前・基準水位)
export interface RsysConvertContext {
  // 🏞️ 水系名 (水系インデックスから解決。未解決なら "")
  systemName: string;
  // 🏞️ 河川コード → 河川名
  riverNames: Map<number, string>;
  // 📍 河川コード → 観測所マスタ
  masters: Map<number, RiverMaster>;
}

// 🏞️ 1水系分の現在値 JSON を河川・ダムの下書きに変換する。
// マスタが無い河川・観測所はコード由来のフォールバック名と基準水位
// null で落とさず取り込む (マスタ取得の失敗で観測値を捨てないため)
export function convertRsysTmList(
  data: unknown,
  ctx: RsysConvertContext,
): { riverDrafts: RiverDraft[]; damDrafts: DamDraft[] } {
  const riverDrafts: RiverDraft[] = [];
  const damDrafts: DamDraft[] = [];
  if (!data || typeof data !== "object") return { riverDrafts, damDrafts };
  const rvrInfo = (data as Record<string, any>).rvrInfo;
  if (!Array.isArray(rvrInfo)) return { riverDrafts, damDrafts };
  for (const rvr of rvrInfo) {
    const rvrCd = numOrNull(rvr?.rvrCd);
    if (rvrCd === null) continue;
    const riverName = ctx.riverNames.get(rvrCd) ?? `河川 ${rvrCd}`;
    const master = ctx.masters.get(rvrCd);
    const tmList = rvr?.tmList ?? {};

    // 🌊 水位観測所 (tmStg)
    for (const e of Array.isArray(tmList.tmStg) ? tmList.tmStg : []) {
      const code = String(e?.obsFcd ?? "");
      if (!code) continue;
      const m = master?.stg.get(code);
      const { levelState, stateSeverity } = levelStateFromTm({ ...e, __master: m });
      riverDrafts.push({
        kind: "river",
        key: `river:level:${code}`,
        metric: "level",
        stationCode: code,
        stationName: m?.name ?? `観測所 ${code}`,
        riverName,
        systemName: ctx.systemName,
        value: valueOrNull(e?.stg, e?.stgCcd),
        rain10m: null,
        observedAt: typeof e?.obsTime === "string" ? e.obsTime : "",
        time: typeof e?.obsTime === "string" ? e.obsTime : "",
        levelState,
        stateSeverity,
        thresholds: m?.thresholds ?? { ...EMPTY_THRESHOLDS },
      });
    }

    // 🌧️ 雨量観測所 (tmRn)。現在値は時間雨量 (rnHr) を代表値とし、
    // 10分雨量 (rn10m) も併せて保持する。基準水位の概念が無いため
    // 状態は欠測以外「平常」として扱う
    for (const e of Array.isArray(tmList.tmRn) ? tmList.tmRn : []) {
      const code = String(e?.obsFcd ?? "");
      if (!code) continue;
      const m = master?.rn.get(code);
      const missing = isMissingCode(e?.rnHrCcd);
      riverDrafts.push({
        kind: "river",
        key: `river:rain:${code}`,
        metric: "rain",
        stationCode: code,
        stationName: m?.name ?? `観測所 ${code}`,
        riverName,
        systemName: ctx.systemName,
        value: valueOrNull(e?.rnHr, e?.rnHrCcd),
        rain10m: valueOrNull(e?.rn10m, e?.rn10mCcd),
        observedAt: typeof e?.obsTime === "string" ? e.obsTime : "",
        time: typeof e?.obsTime === "string" ? e.obsTime : "",
        levelState: missing ? "欠測" : "平常",
        stateSeverity: missing ? -1 : 0,
        thresholds: { ...EMPTY_THRESHOLDS },
      });
    }

    // 🏞️ ダム (tmDam)。貯水率は有効容量 (storPcntEff) を優先し、
    // 欠測なら利水容量 (storPcntIrr) で代替する
    for (const e of Array.isArray(tmList.tmDam) ? tmList.tmDam : []) {
      const code = String(e?.obsFcd ?? "");
      if (!code) continue;
      const m = master?.dam.get(code);
      const outflow = valueOrNull(e?.allDisch, e?.allDischCcd);
      damDrafts.push({
        kind: "dam",
        key: `dam:${code}`,
        damCode: code,
        name: m?.name ?? `ダム ${code}`,
        riverName,
        systemName: ctx.systemName,
        storageLevel: valueOrNull(e?.storLvl, e?.storLvlCcd),
        storageRate: valueOrNull(e?.storPcntEff, e?.storPcntEffCcd) ?? valueOrNull(e?.storPcntIrr, e?.storPcntIrrCcd),
        inflow: valueOrNull(e?.allSink, e?.allSinkCcd),
        outflow,
        discharging: outflow !== null && outflow > 0,
        observedAt: typeof e?.obsTime === "string" ? e.obsTime : "",
        time: typeof e?.obsTime === "string" ? e.obsTime : "",
      });
    }
  }
  return { riverDrafts, damDrafts };
}
