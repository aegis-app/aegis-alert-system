// ==========================================
// 🗄️ イベントストア (保持・重複排除・永続化)
// ==========================================
// 📌 取り込んだイベントを同一視キーで保持し、重複排除と更新判定を行う。
// 保持はメモリ + JSON ファイル (data/events.json) で、再起動後に復元する。
// 長期の履歴・統計はクライアント側の領分であり、ここは「直近の配信」が
// 目的のため、件数と期間に上限を設けて古いものから落とす。
// 変更判定は (key, updatedAt) の組が契約: 内容の署名が変わらない再取り
// 込みでは updatedAt を進めず change = "none" を返すため、クライアントは
// since = 最後に見た updatedAt で REST 回収すれば取りこぼしが無い
// (境界は >= で含むため、境界の1件は重複して届きうるが欠落はしない)。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseP2pTime } from "./util.js";
import { EVENT_KINDS } from "./types.js";
import type {
  A2sEvent,
  EewEvent,
  EventDraft,
  EventKind,
  HeatDraft,
  HeatEvent,
  SedimentDraft,
  SedimentEvent,
  SourceId,
  WarningDraft,
  WarningEvent,
} from "./types.js";

// 📦 ストアの生成オプション
export interface StoreOptions {
  // 💾 永続化先ファイル (省略時はメモリのみ)
  filePath?: string;
  // 📦 種別ごとの保持上限
  caps?: Partial<Record<EventKind, number>>;
  // 📦 全体の保持上限
  totalCap?: number;
  // 🕐 保持期間 (時間)。イベント時刻がこれより古いものは落とす
  maxAgeHours?: number;
}

// 📥 取り込み結果の変更種別
export type IngestChange = "new" | "updated" | "none";
export interface IngestResult {
  event: A2sEvent;
  change: IngestChange;
}

// 📦 種別ごとの保持上限の考え方:
// - warning は一次細分区域の総数 (約140) が物理的な上限になるため、
//   その倍程度の 300 (有効集合が入り切る値)
// - typhoon は同時存在数が一桁台のため 10
// - sediment は市町村単位の有効集合で、大規模災害時は数百市町村に
//   達しうるため 500。flood は予報区域単位で同時発表が限られるため 100、
//   volcano は火山単位で 100、tornado / record-rain / linear-rain は
//   短命・低頻度のため各 50
// - river / dam は川の防災情報の実数 (水位 約6,900 + 雨量 約6,800 =
//   約13,700局、ダム 約870基) に基づき、river 16000 / dam 1200。
//   heat は府県予報区の総数 (58区域) を上回る 100
// - 全体上限は各種別の合計 (18790) を上回る 19500 とし、有効集合
//   (warning / sediment / heat) が履歴を全体 cap で圧迫しないようにする
const DEFAULT_CAPS: Record<EventKind, number> = {
  quake: 100,
  eew: 200,
  tsunami: 30,
  warning: 300,
  typhoon: 10,
  flood: 100,
  sediment: 500,
  tornado: 50,
  "record-rain": 50,
  "linear-rain": 50,
  volcano: 100,
  river: 16000,
  dam: 1200,
  heat: 100,
};
const DEFAULT_TOTAL_CAP = 19500;
const DEFAULT_MAX_AGE_HOURS = 72;

// 💾 永続化から除外する種別: river / dam は10分ごとに全件 (約1.5万件)
// が変化しうる観測値であり、events.json への書き込み churn とファイル
// 肥大が常駐メモリとディスクを圧迫する。観測値は再起動後の次回
// ポーリング (10分以内) で全件再取得できるため、メモリ保持のみとする
// (load 時に旧ファイルへ混入していても読み飛ばす)
const NON_PERSISTENT_KINDS: ReadonlySet<EventKind> = new Set(["river", "dam"]);

// 📋 SSE スナップショット再生から除外する種別: river / dam は「最新値の
// 参照データ」であり、保持件数が約1.4万件に達するため、接続のたびに
// 全件再生すると再接続のコストと帯域を圧迫する。現在値は REST
// /v1/events?kind=river|dam で参照でき、ライブの状態遷移は broadcast
// で従来どおり届くため、再生対象からだけ外す (保持・REST 一覧からは外さない)
const SNAPSHOT_REPLAY_EXCLUDED_KINDS: ReadonlySet<EventKind> = new Set(["river", "dam"]);

// ⚠️ 年齢ガード・年齢 prune の対象外とする有効集合型の種別。
// warning / sediment / heat は「現在有効な集合」であり、長期継続する
// 発表 (乾燥注意報など) があるため年齢では落とさず、解除はスナップ
// ショットの差分でのみ扱う
const ACTIVE_SET_KINDS: ReadonlySet<EventKind> = new Set(["warning", "sediment", "heat"]);

// 🌍 ストア上の同一性キー。EEW は取消でも同一イベントとして扱うため
// baseKey を使い、それ以外は key そのものを使う
export function storeKeyOf(draft: EventDraft): string {
  return draft.kind === "eew" ? draft.baseKey : draft.key;
}

// 🔍 キー順に依存しない安定した JSON 化 (署名用)
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

// 🔍 内容の同一性判定に使う署名 (封筒フィールドを除く)
function signatureOf(ev: EventDraft | A2sEvent): string {
  const { ...rest } = ev as Record<string, unknown>;
  delete rest.source;
  delete rest.sources;
  delete rest.receivedAt;
  delete rest.updatedAt;
  return stableStringify(rest);
}

// 🕐 時刻文字列をミリ秒へ変換する。P2P 表記 ("2026/11/19 06:41:00") を
// 優先し、読めなければ ISO 8601 表記 (warning の reportDatetime、電文系
// の発表日時) として Date.parse で試す。全 kind 共通の規則とし、年齢
// ガードと prune が ISO 表記の種別でも正しく効くようにする
function timeStringMs(t: string | undefined | null): number | null {
  if (!t) return null;
  const d = parseP2pTime(t);
  if (d) return d.getTime();
  const iso = Date.parse(t);
  return Number.isNaN(iso) ? null : iso;
}

// 🕐 下書きのイベント時刻 (保持期間の判定用)。EEW は発生時刻、それ以外は
// 代表時刻 (time) を使う。読めなければ null (ガードの対象外にする)
function draftTimeMs(draft: EventDraft): number | null {
  const t = draft.kind === "eew" ? draft.originTime : draft.time;
  return timeStringMs(t);
}

// 🕐 イベントの代表時刻 (保持期間の判定用)。読めなければ更新時刻で代替する
function eventTimeMs(ev: A2sEvent): number {
  // 🌀 台風は発生・発表時刻の概念が無く、内容が変わらない間は updatedAt も
  // 動かないため、「最後に存在を確認した時刻」(再取り込みで更新される
  // updatedAt) を保持期間の起点にする。存在し続ける間は落ちず、
  // targetTc から消えて確認が止まれば72時間で落ちる
  if (ev.kind === "typhoon") {
    const u = Date.parse(ev.updatedAt);
    return Number.isNaN(u) ? 0 : u;
  }
  const t = ev.kind === "eew" ? ev.originTime : ev.time;
  const ms = timeStringMs(t);
  if (ms !== null) return ms;
  const u = Date.parse(ev.updatedAt);
  return Number.isNaN(u) ? 0 : u;
}

// 🚨 EEW の統合規則: 同一イベントの複数報から、クライアントへ配信すべき
// 1件を選ぶ。取消は終端状態として優先し、それ以外は警報 (isWarn) →
// 報番号 → 発表時刻の順で新しい情報を優先する。
// ⚠️ 報番号 (serial) は同一経路どうしのときだけ比較する。556 と Wolfx
// では serial の数え方が同一尺度と確認できなかった (同一イベントで
// 556 は serial 1→2、Wolfx は Serial 3 と食い違う実例がある) ため、
// 経路をまたぐ場合は報番号を比べず発表時刻で決める
function eewWinner(
  existing: EewEvent,
  draft: EventDraft & { kind: "eew" },
  sameRoute: boolean,
): "draft" | "existing" {
  if (draft.cancel !== existing.cancel) {
    // 📌 取消への遷移は常に取り込む。取消後の非取消報は通常来ないため既存を守る
    return draft.cancel ? "draft" : "existing";
  }
  if (draft.isWarn !== existing.isWarn) {
    return draft.isWarn ? "draft" : "existing";
  }
  if (sameRoute) {
    const serialDiff = (draft.serial ?? -1) - (existing.serial ?? -1);
    if (serialDiff !== 0) return serialDiff > 0 ? "draft" : "existing";
  }
  return draft.time > existing.time ? "draft" : "existing";
}

// 📳 areaScales の要素単位マージ: 同一地域 (都道府県+区域名) は1件に
// まとめ、上限 (scaleTo) は持っている側を優先する。勝者が Wolfx 由来
// (scaleTo は常に null) でも、敗れた 556 由来の scaleTo が落ちない
// ようにするための規則
function mergeAreaScales(
  keep: EewEvent["areaScales"],
  fill: EewEvent["areaScales"],
): EewEvent["areaScales"] {
  const out = keep.map((a) => ({ ...a }));
  for (const f of fill) {
    const idx = out.findIndex((a) => a.pref === f.pref && a.name === f.name);
    if (idx < 0) {
      out.push({ ...f });
      continue;
    }
    if (out[idx].scaleTo === null && f.scaleTo !== null) {
      out[idx] = { ...out[idx], scaleTo: f.scaleTo };
    }
  }
  return out;
}

// 📌 WarnArea 由来フィールド (prefs / areaArrivals / areaScales) の補完。
// Wolfx の最終報のように WarnArea を含まない電文があり、勝者総取りでは
// 途中報で得た地域情報が消えてしまう (実イベントで areaScales が空に
// なり、EEW 地図の地域の塗りが描かれなかった)。3フィールドとも
// 「空でない側を優先する」: keep が空で fill が持っている場合だけ fill を使う
function complementAreaFields(
  keep: Pick<EewEvent, "prefs" | "areaArrivals" | "areaScales">,
  fill: Pick<EewEvent, "prefs" | "areaArrivals" | "areaScales">,
): Pick<EewEvent, "prefs" | "areaArrivals" | "areaScales"> {
  return {
    prefs: keep.prefs.length > 0 ? keep.prefs : fill.prefs,
    areaArrivals: keep.areaArrivals.length > 0 ? keep.areaArrivals : fill.areaArrivals,
    // 📳 areaScales は全有無ではなく要素単位でマージし、scaleTo を
    // 持つ側 (556) の値が勝者の null に負けて落ちないようにする
    areaScales: mergeAreaScales(keep.areaScales, fill.areaScales),
  };
}

// 📌 保存データの正規化: 旧バージョンが保存した events.json は、後から
// 追加されたフィールドを持たないことがある (例: 旧 EEW は isFinal が
// undefined のまま保存されうる)。load 時に種別ごとの既定値で補い、
// 型どおりの値が常に保持されるようにする。保存形式そのものへの版数
// 付与は行わない: フィールド追加はすべて「欠落 = 既定値」で吸収できる
// 間は移行が不要なため
function normalizeLoadedEvent(ev: A2sEvent): void {
  const rec = ev as unknown as Record<string, unknown>;
  // 📦 封筒フィールド
  if (!Array.isArray(ev.sources)) {
    ev.sources = typeof ev.source === "string" ? [ev.source] : [];
  }
  if (typeof ev.source !== "string") {
    ev.source = (ev.sources[0] ?? "p2p") as SourceId;
  }
  if (typeof ev.receivedAt !== "string") ev.receivedAt = typeof ev.updatedAt === "string" ? ev.updatedAt : new Date(0).toISOString();
  if (typeof ev.updatedAt !== "string") ev.updatedAt = ev.receivedAt;
  const boolOr = (k: string, fallback: boolean): void => {
    if (typeof rec[k] !== "boolean") rec[k] = fallback;
  };
  const arrayOr = (k: string): void => {
    if (!Array.isArray(rec[k])) rec[k] = [];
  };
  const nullOr = (k: string): void => {
    if (rec[k] === undefined) rec[k] = null;
  };
  switch (ev.kind) {
    case "quake":
      arrayOr("prefScales");
      arrayOr("points");
      nullOr("originTime");
      nullOr("tsunamiText");
      nullOr("topPoint");
      nullOr("magnitude");
      nullOr("depthKm");
      nullOr("lat");
      nullOr("lon");
      boolOr("foreign", false);
      boolOr("topPointIsArea", false);
      break;
    case "eew":
      boolOr("cancel", false);
      boolOr("isWarn", false);
      boolOr("isFinal", false);
      boolOr("isAssumption", false);
      arrayOr("prefs");
      arrayOr("areaArrivals");
      arrayOr("areaScales");
      nullOr("serial");
      nullOr("eventId");
      nullOr("lat");
      nullOr("lon");
      nullOr("depthKm");
      nullOr("estMagnitude");
      break;
    case "tsunami":
      arrayOr("areas");
      boolOr("cancelled", false);
      if (typeof ev.grade !== "string") ev.grade = "Unknown";
      break;
    case "warning":
      arrayOr("warnings");
      boolOr("released", false);
      if (typeof ev.maxSeverity !== "number") ev.maxSeverity = 0;
      break;
    case "typhoon":
      arrayOr("lines");
      if (!ev.fields || typeof ev.fields !== "object") ev.fields = {};
      nullOr("number");
      nullOr("name");
      nullOr("englishName");
      if (typeof ev.time !== "string") ev.time = "";
      break;
    // 🌐 電文系ドメイン: 配列・真偽・レベルの欠落を既定値で補う
    case "flood":
      arrayOr("rivers");
      arrayOr("stations");
      boolOr("cancelled", false);
      if (typeof ev.severity !== "number") ev.severity = 0;
      break;
    case "sediment":
      boolOr("released", false);
      break;
    case "tornado":
      arrayOr("areas");
      boolOr("witnessed", false);
      nullOr("validUntil");
      break;
    case "record-rain":
      arrayOr("areas");
      nullOr("station");
      nullOr("rainfallMm");
      nullOr("rainfallLabel");
      nullOr("rainfallType");
      break;
    case "linear-rain":
      arrayOr("areas");
      break;
    case "volcano":
      arrayOr("areas");
      nullOr("level");
      nullOr("levelName");
      if (typeof rec.category !== "string") rec.category = "その他";
      break;
    // 🏞️ 観測値系: 数値・状態・基準水位の欠落を補う
    case "river":
      nullOr("value");
      nullOr("rain10m");
      if (typeof rec.levelState !== "string") rec.levelState = "平常";
      if (typeof rec.stateSeverity !== "number") rec.stateSeverity = 0;
      if (!rec.thresholds || typeof rec.thresholds !== "object") {
        rec.thresholds = { standby: null, caution: null, refuge: null, danger: null, flood: null };
      }
      break;
    case "dam":
      nullOr("storageLevel");
      nullOr("storageRate");
      nullOr("inflow");
      nullOr("outflow");
      boolOr("discharging", false);
      break;
    // 🌡️ 熱中症: レベルと対象日の欠落を補う
    case "heat":
      boolOr("released", false);
      if (typeof rec.level !== "number") rec.level = 0;
      if (typeof rec.levelName !== "string") rec.levelName = "発表なし";
      if (!rec.target1 || typeof rec.target1 !== "object") rec.target1 = { date: "", flag: 0 };
      if (!rec.target2 || typeof rec.target2 !== "object") rec.target2 = { date: "", flag: 0 };
      nullOr("maxWbgt");
      nullOr("maxWbgtStation");
      break;
  }
}

// 🗄️ イベントストア
export class EventStore {
  private events = new Map<string, A2sEvent>();
  private readonly filePath?: string;
  private readonly caps: Record<EventKind, number>;
  private readonly totalCap: number;
  private readonly maxAgeMs: number;
  private saveTimer: NodeJS.Timeout | null = null;
  // 📝 永続化の失敗を繰り返し報告しないための記録
  private saveErrorReported = false;

  constructor(options: StoreOptions = {}) {
    this.filePath = options.filePath;
    this.caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) };
    this.totalCap = options.totalCap ?? DEFAULT_TOTAL_CAP;
    this.maxAgeMs = (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 60 * 60 * 1000;
  }

  // 🔢 全体保持上限 (REST /v1/events の limit 上限との整合に使う)
  get totalCapacity(): number {
    return this.totalCap;
  }

  // 💾 ファイルから復元する。壊れたファイルは空として扱い、起動を止めない
  load(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // ファイルが無いのは初回起動として正常
    }
    try {
      const arr = JSON.parse(raw) as A2sEvent[];
      if (!Array.isArray(arr)) return;
      for (const ev of arr) {
        if (!ev || typeof ev !== "object" || typeof ev.key !== "string" || typeof ev.kind !== "string") continue;
        // 💾 永続化除外の種別 (river / dam) は旧ファイルに混入していても
        // 復元しない (次回ポーリングで再取得される観測値のため)
        if (NON_PERSISTENT_KINDS.has(ev.kind)) continue;
        // 📌 旧形式データでフィールドが欠けていても配信・統合・差分計算が
        // 壊れないよう、種別ごとの既定値で正規化してから保持する
        normalizeLoadedEvent(ev);
        this.events.set(storeKeyOf(ev as EventDraft), ev);
      }
      this.prune();
    } catch {
      // ⚠️ 復元できない場合は空から始める (取り込みで再び埋まる)
    }
  }

  // 📥 イベントを取り込む。新規 / 更新 / 変化なしを返し、更新時は
  // 呼び出し側 (配信) が使う最新イベントを返す
  ingest(draft: EventDraft, source: SourceId): IngestResult {
    const nowIso = new Date().toISOString();
    // 🌊 津波の経路間キー吸収: P2P のキーは P2P 電文 ID ("552:<16進ID>")
    // で、DMDSS 経路の発表時刻キー ("552:<発表時刻>") とは一致しない。
    // 同じ発表の津波が両経路から届く移行期間中は、発表時刻が一致し
    // 区域名を1つ以上共有する既存イベントを同一とみなし、下書きのキーを
    // 既存キーへ寄せてから通常の取り込みに乗せる。キーの付け替えでは
    // なく寄せるだけのため、イベントの消失やキーの揺れは起きない
    if (draft.kind === "tsunami" && !this.events.has(draft.key)) {
      for (const ev of this.events.values()) {
        if (ev.kind !== "tsunami" || ev.time !== draft.time) continue;
        const shared = draft.areas.some(
          (a) => a.name !== "" && ev.areas.some((b) => b.name === a.name),
        );
        if (!shared) continue;
        draft = { ...draft, key: ev.key };
        break;
      }
    }
    const skey = storeKeyOf(draft);
    let existing = this.events.get(skey);

    // ⛔ 保持期間 (72h) を過ぎた下書きは保存も配信もしない。このガードが
    // 無いと、ポーリング窓に残る古い電文を取り込むたびに prune で消え、
    // 次回ポーリングで再び「新規」として無限に再配信され、events.json の
    // 保存もポーリングのたびに走り続ける。時刻が読めない下書きは対象外
    // とし、従来どおり取り込んで prune (更新時刻での代替判定) に委ねる
    const draftMs = draftTimeMs(draft);
    if (draftMs !== null && Date.now() - draftMs > this.maxAgeMs) {
      if (existing) return { event: existing, change: "none" };
      const ev = { ...draft, source, sources: [source], receivedAt: nowIso, updatedAt: nowIso } as A2sEvent;
      return { event: ev, change: "none" };
    }

    // 🌍 地震のキー移行の吸収: 震度速報だけの段階ではキーが
    // "551:<時刻>|不明" (震源名フォールバック) になり、詳細報で座標が
    // 判明すると "551:<時刻>|@<座標>" に変わる。キー生成側ではポーリング
    // をまたぐ移行を吸収できないため、ストア側で「同一発生時刻・キー
    // 接尾辞の一方が座標でない (または震源名が一致する)」既存イベントを
    // 同一イベントとみなし、新しいキーへ付け替える
    if (!existing && draft.kind === "quake") {
      for (const [k, ev] of this.events) {
        if (ev.kind !== "quake" || ev.time !== draft.time) continue;
        const oldSuffix = ev.key.split("|")[1] ?? "";
        const newSuffix = draft.key.split("|")[1] ?? "";
        const compatible =
          !oldSuffix.startsWith("@") || !newSuffix.startsWith("@") || ev.hypocenter === draft.hypocenter;
        if (!compatible) continue;
        existing = ev;
        this.events.delete(k);
        break;
      }
    }

    if (!existing) {
      const ev = { ...draft, source, sources: [source], receivedAt: nowIso, updatedAt: nowIso } as A2sEvent;
      this.events.set(skey, ev);
      this.prune();
      this.scheduleSave();
      return { event: ev, change: "new" };
    }

    // 📡 経路の合流は内容の変化がなくても記録する (配信はしない)
    const sources = existing.sources.includes(source)
      ? existing.sources
      : [...existing.sources, source];

    // 🌀 台風は内容が同じでも「存在を確認できた」こと自体が保持の根拠に
    // なるため、変化なしでも updatedAt (最終確認時刻) だけを進める。
    // これにより長期停滞する台風が72時間で落ちず、消えた台風は確認が
    // 止まってから72時間で落ちる。配信はしない (change は "none")
    if (
      draft.kind === "typhoon" &&
      existing.kind === "typhoon" &&
      signatureOf(draft) === signatureOf(existing)
    ) {
      const refreshed = { ...existing, sources, updatedAt: nowIso } as A2sEvent;
      this.events.set(skey, refreshed);
      this.scheduleSave();
      return { event: refreshed, change: "none" };
    }

    // 🚨 EEW は統合規則で勝者を選ぶ。それ以外は新しい下書きが常に勝つ。
    // 報番号の比較は同一経路どうしに限る
    let winnerIsDraft = true;
    if (draft.kind === "eew" && existing.kind === "eew") {
      winnerIsDraft = eewWinner(existing, draft, existing.source === source) === "draft";
    }
    // 📌 isFinal (最終報) は取消と同じ終端の事実として扱い、勝者の選定に
    // 関わらず粘着保持する。Wolfx の最終報は予報 (isWarn=false) で届く
    // ことが多く、警報が勝者になる統合で落とすと、判明したはずの
    // 「最終報」が表示から消えてしまうため
    const stickyFinal =
      draft.kind === "eew" && existing.kind === "eew"
        ? Boolean(existing.isFinal) || draft.isFinal
        : null;
    // 🌊 洪水予報の解除 (cancelled) も tsunami の cancelled と同じ終端の
    // 事実として粘着保持する。解除後に古い発表電文が遅れて届いても、
    // 解除済みの予報が復活しないようにするため
    const stickyCancelled =
      draft.kind === "flood" && existing.kind === "flood"
        ? Boolean(existing.cancelled) || draft.cancelled
        : null;
    if (!winnerIsDraft) {
      if (draft.kind === "eew" && existing.kind === "eew") {
        // 📌 勝者が既存側でも、負けた下書きだけが持つ情報は補完して
        // 取り込む: isFinal の粘着保持と、WarnArea 由来フィールドの
        // 非空優先。どちらかで内容が変われば更新として配信する
        const merged = {
          ...existing,
          isFinal: stickyFinal ?? existing.isFinal,
          ...complementAreaFields(existing, draft),
          sources,
          updatedAt: nowIso,
        } as A2sEvent;
        if (signatureOf(merged) !== signatureOf(existing)) {
          this.events.set(skey, merged);
          this.scheduleSave();
          return { event: merged, change: "updated" };
        }
      }
      if (sources !== existing.sources) {
        this.events.set(skey, { ...existing, sources });
        this.scheduleSave();
      }
      return { event: existing, change: "none" };
    }

    const candidate = {
      ...draft,
      ...(stickyFinal !== null ? { isFinal: stickyFinal } : {}),
      ...(stickyCancelled !== null ? { cancelled: stickyCancelled } : {}),
      // 📌 勝った下書きが WarnArea 由来フィールドを持たない場合は既存
      // から補完する (最終報が途中報の地域情報を消さないため)
      ...(draft.kind === "eew" && existing.kind === "eew"
        ? complementAreaFields(draft, existing)
        : {}),
      source,
      sources,
      receivedAt: existing.receivedAt,
      updatedAt: nowIso,
    } as A2sEvent;
    if (signatureOf(candidate) === signatureOf(existing)) {
      // 📌 内容が同じなら更新扱いにしない (ポーリングのたびに配信しないため)
      if (sources !== existing.sources || existing.source !== source) {
        this.events.set(skey, { ...existing, sources });
        this.scheduleSave();
      }
      return { event: existing, change: "none" };
    }
    this.events.set(skey, candidate);
    this.prune();
    this.scheduleSave();
    return { event: candidate, change: "updated" };
  }

  // 🔍 同一視キーで保持中のイベントを1件引く (無ければ undefined)。
  // スナップショット型ドメイン (river / dam) の遷移判定のために、
  // 取り込み側が取り込み前後で状態を比較する用途
  getEvent(key: string): A2sEvent | undefined {
    return this.events.get(key);
  }

  // 📋 イベントの一覧を返す (更新が新しい順)。kind / source / since
  // (更新時刻) / limit で絞れる。since は境界を含む (>=) ため、切断した
  // クライアントが「最後に見た updatedAt」を渡せば取りこぼしなく回収
  // できる (境界の1件は重複しうるが、(key, updatedAt) で判定できる)
  list(
    filter: { kind?: EventKind; source?: SourceId; sinceMs?: number; limit?: number } = {},
  ): A2sEvent[] {
    let out = [...this.events.values()];
    if (filter.kind) out = out.filter((e) => e.kind === filter.kind);
    // 📡 source は「その経路で取り込みが確認できた」イベントに絞る
    // (sources は合流した全経路を保持するため、片方の経路で届いた
    // イベントも両方の経路名で引ける)
    if (filter.source) out = out.filter((e) => e.sources.includes(filter.source!));
    if (filter.sinceMs !== undefined) {
      out = out.filter((e) => Date.parse(e.updatedAt) >= filter.sinceMs!);
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  // 📋 SSE 接続時のスナップショット用 (古い順 = 再生順)。
  // 既定の上限はストアの全体保持上限にそろえる (上限が小さいと保持中の
  // 古いイベントがスナップショットで回収できない隙間ができる)。ただし
  // river / dam は再生から除外する (SNAPSHOT_REPLAY_EXCLUDED_KINDS の
  // コメント参照)。除外を外したい呼び出し側は excludedKinds に空集合を渡す
  snapshot(
    limit = this.totalCap,
    excludedKinds: ReadonlySet<EventKind> = SNAPSHOT_REPLAY_EXCLUDED_KINDS,
  ): A2sEvent[] {
    const all = this.list({});
    const filtered = excludedKinds.size > 0 ? all.filter((e) => !excludedKinds.has(e.kind)) : all;
    return filtered.slice(0, limit).reverse();
  }

  // 🔢 種別ごとの保持件数
  counts(): Record<EventKind, number> & { total: number } {
    const c = Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<EventKind, number>;
    for (const ev of this.events.values()) {
      // 📌 未知の kind (旧形式データ等) で NaN にしない
      if (Object.hasOwn(c, ev.kind)) c[ev.kind] += 1;
    }
    return { ...c, total: this.events.size };
  }

  // 🧩 有効集合型ドメインの汎用スナップショット適用。「現在有効な集合」を
  // 持つドメイン (警報・注意報、土砂災害警戒情報、熱中症警戒アラート)
  // のための kind 非依存の差分機構。対象 kind とスコープ (警報では
  // 官署コード) をパラメータ化してある:
  // - 取得に成功したスコープの集合と、その時点の有効要素の下書き一覧を
  //   受け取り、スコープ単位で差分を計算する
  // - 新規に有効になった要素 → "new"、内容が変わった要素 → "updated"
  // - 前回有効だったが今回 (取得成功したスコープの範囲で) 消えた要素 →
  //   makeReleased が作る解除イベントを "updated" として配信専用に返し、
  //   ストアからは除く (解除イベント自体は保存しない)
  // - 取得に失敗したスコープの要素は差分の対象外とし、前回状態をそのまま
  //   保持する (障害で全解除に見せないため)
  // 変化のあった分だけを IngestResult の配列で返す (変化なしは含めない)
  applySnapshot(params: {
    kind: EventKind;
    drafts: EventDraft[];
    fetchedScopes: Iterable<string>;
    scopeOfDraft: (draft: EventDraft) => string;
    scopeOfEvent: (ev: A2sEvent) => string;
    isActiveDraft?: (draft: EventDraft) => boolean;
    makeReleased: (ev: A2sEvent, source: SourceId, nowIso: string) => A2sEvent;
    source: SourceId;
  }): IngestResult[] {
    const { kind, source } = params;
    const nowIso = new Date().toISOString();
    const fetched = new Set(params.fetchedScopes);
    const results: IngestResult[] = [];
    let changed = false;

    // 📥 下書きはキーで重複排除する (後のものを正とする)
    const draftByKey = new Map<string, EventDraft>();
    for (const d of params.drafts) {
      if (d.kind !== kind) continue;
      if (params.isActiveDraft && !params.isActiveDraft(d)) continue;
      if (!fetched.has(params.scopeOfDraft(d))) continue; // 取得成功範囲外は採らない
      draftByKey.set(storeKeyOf(d), d);
    }

    for (const draft of draftByKey.values()) {
      const skey = storeKeyOf(draft);
      const existing = this.events.get(skey);
      if (!existing) {
        const ev = {
          ...draft,
          source,
          sources: [source],
          receivedAt: nowIso,
          updatedAt: nowIso,
        } as A2sEvent;
        this.events.set(skey, ev);
        results.push({ event: ev, change: "new" });
        changed = true;
        continue;
      }
      const sources =
        existing.sources.includes(source) ? existing.sources : [...existing.sources, source];
      const candidate = {
        ...draft,
        source,
        sources,
        receivedAt: existing.receivedAt,
        updatedAt: nowIso,
      } as A2sEvent;
      if (signatureOf(candidate) === signatureOf(existing)) {
        if (sources !== existing.sources) {
          this.events.set(skey, { ...existing, sources });
          changed = true;
        }
        continue;
      }
      this.events.set(skey, candidate);
      results.push({ event: candidate, change: "updated" });
      changed = true;
    }

    // 🗑️ 取得に成功したスコープの範囲で消えた要素は解除として配信し、除く
    for (const [skey, ev] of [...this.events]) {
      if (ev.kind !== kind) continue;
      if (!fetched.has(params.scopeOfEvent(ev))) continue; // 取得失敗スコープは保持
      if (draftByKey.has(skey)) continue;
      this.events.delete(skey);
      results.push({ event: params.makeReleased(ev, source, nowIso), change: "updated" });
      changed = true;
    }

    if (changed) {
      this.prune();
      this.scheduleSave();
    }
    return results;
  }

  // ⚠️ 警報・注意報のスナップショット適用 (有効集合型の汎用機構の
  // warning 向けパラメータ指定)。スコープは官署コード、解除イベントは
  // warnings: [] / maxSeverity: 0 / released: true の形にする
  applyWarningSnapshot(
    drafts: WarningDraft[],
    fetchedOfficeCodes: Iterable<string>,
    source: SourceId = "jma",
  ): IngestResult[] {
    return this.applySnapshot({
      kind: "warning",
      drafts,
      fetchedScopes: fetchedOfficeCodes,
      scopeOfDraft: (d) => (d as WarningDraft).officeCode,
      scopeOfEvent: (ev) => (ev as WarningEvent).officeCode,
      isActiveDraft: (d) => !(d as WarningDraft).released,
      makeReleased: (ev, src, nowIso) => {
        const w = ev as WarningEvent;
        return {
          ...w,
          warnings: [],
          maxSeverity: 0,
          released: true,
          source: src,
          sources: w.sources.includes(src) ? w.sources : [...w.sources, src],
          updatedAt: nowIso,
        } as A2sEvent;
      },
      source,
    });
  }

  // 🏔️ 土砂災害警戒情報のスナップショット適用 (有効集合型の汎用機構の
  // sediment 向けパラメータ指定)。スコープは都道府県名、解除イベントは
  // released: true の形にする。電文は完全集合型 (Body が県内全市町村の
  // 状態を列挙する) のため、変換側が出した警戒集合をそのまま渡す
  applySedimentSnapshot(
    drafts: SedimentDraft[],
    fetchedPrefNames: Iterable<string>,
    source: SourceId = "jma-xml",
  ): IngestResult[] {
    return this.applySnapshot({
      kind: "sediment",
      drafts,
      fetchedScopes: fetchedPrefNames,
      scopeOfDraft: (d) => (d as SedimentDraft).prefName,
      scopeOfEvent: (ev) => (ev as SedimentEvent).prefName,
      isActiveDraft: (d) => !(d as SedimentDraft).released,
      makeReleased: (ev, src, nowIso) => {
        const s = ev as SedimentEvent;
        return {
          ...s,
          released: true,
          source: src,
          sources: s.sources.includes(src) ? s.sources : [...s.sources, src],
          updatedAt: nowIso,
        } as A2sEvent;
      },
      source,
    });
  }

  // 🌡️ 熱中症警戒アラートのスナップショット適用 (有効集合型の汎用機構の
  // heat 向けパラメータ指定)。スコープは CSV 全体を1つ ("wbgt-alert")
  // とし、解除イベントは level: 0 / levelName: 「発表なし」 /
  // released: true の形にする。ファイルが取得できた場合のみ呼び出す
  // こと (取得できない場合は呼び出さず、前回状態を保持する)
  applyHeatSnapshot(
    drafts: HeatDraft[],
    fetchedScopes: Iterable<string> = ["wbgt-alert"],
    source: SourceId = "wbgt",
  ): IngestResult[] {
    return this.applySnapshot({
      kind: "heat",
      drafts,
      fetchedScopes,
      scopeOfDraft: () => "wbgt-alert",
      scopeOfEvent: () => "wbgt-alert",
      isActiveDraft: (d) => !(d as HeatDraft).released && (d as HeatDraft).level > 0,
      makeReleased: (ev, src, nowIso) => {
        const h = ev as HeatEvent;
        return {
          ...h,
          level: 0,
          levelName: "発表なし",
          released: true,
          source: src,
          sources: h.sources.includes(src) ? h.sources : [...h.sources, src],
          updatedAt: nowIso,
        } as A2sEvent;
      },
      source,
    });
  }

  // ✂️ 保持上限と保持期間で古いイベントを落とす
  prune(): void {
    const now = Date.now();
    for (const [k, ev] of this.events) {
      // ⚠️ 有効集合型 (warning / sediment / heat) は年齢制限の対象外。
      // 発表が続く限り保持し、解除はスナップショットの差分で除かれる
      if (ACTIVE_SET_KINDS.has(ev.kind)) continue;
      if (now - eventTimeMs(ev) > this.maxAgeMs) this.events.delete(k);
    }
    // 📦 種別ごと・全体の上限は、更新が古いものから落とす
    const byUpdatedAsc = (a: A2sEvent, b: A2sEvent) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    for (const kind of Object.keys(this.caps) as EventKind[]) {
      const ofKind = [...this.events.values()].filter((e) => e.kind === kind).sort(byUpdatedAsc);
      while (ofKind.length > this.caps[kind]) {
        const victim = ofKind.shift()!;
        this.events.delete(storeKeyOf(victim as EventDraft));
      }
    }
    const all = [...this.events.values()].sort(byUpdatedAsc);
    while (all.length > this.totalCap) {
      const victim = all.shift()!;
      this.events.delete(storeKeyOf(victim as EventDraft));
    }
  }

  // 💾 永続化を予約する (短時間の連続取り込みを1回の書き込みにまとめる)
  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  // 💾 現在の保持内容をファイルへ書く (tmp へ書いてから rename する原子的書き込み)
  saveNow(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      // 💾 永続化除外の種別 (river / dam) は書き出さない
      // (NON_PERSISTENT_KINDS のコメント参照)
      const persistent = [...this.events.values()].filter((ev) => !NON_PERSISTENT_KINDS.has(ev.kind));
      writeFileSync(tmp, JSON.stringify(persistent), "utf8");
      renameSync(tmp, this.filePath);
      this.saveErrorReported = false;
    } catch (err) {
      if (!this.saveErrorReported) {
        this.saveErrorReported = true;
        console.warn(
          `[${new Date().toISOString()}] ⚠️ イベントの永続化に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
