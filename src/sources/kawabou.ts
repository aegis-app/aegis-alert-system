// ==========================================
// 🏞️ 国土交通省「川の防災情報」観測値 (水位・雨量・ダム) の取り込み
// ==========================================
// 📌 川の防災情報 (https://www.river.go.jp/) のサイト内部 JSON を使う。
// 公式 API ではないため、取得間隔は元データの10分粒度に合わせ、過剰な
// ポーリングをしない (hub.ts の河川ポーリング間隔の既定は10分)。
// 値は速報値 (未精査) で異常値を含み得る。出典: 国土交通省 川の防災情報。
// 変換は convert/kawabou.ts が担い、本ファイルはマスタ類のキャッシュ
// (状態持ちの解決器) と全国巡回の取得を行う。
// ⚠️ ハブ側の河川取り込みは現行本番で無効化中 (A2S_RIVER_INTERVAL_MS=0)。
// ここでは配線だけを用意し、有効化は恒久対策 (分割巡回) の別課題とする。
import { USER_AGENT, numOrNull, sleepMs } from "../util.js";
import {
  KAWABOU_PREF_CODES,
  buildPrefRsysIndexUrl,
  buildRsysIndexUrl,
  buildRsysTmListUrl,
  buildRvrMasterUrl,
  buildTmCrntTimeUrl,
  convertRsysTmList,
  kawabouDatePath,
  parseRsysIndex,
  parseRvrMaster,
  type RiverMaster,
} from "../convert/kawabou.js";
import type { DamDraft, RiverDraft } from "../types.js";

// ------------------------------------------
// 🔄 共通の取得ヘルパー (User-Agent + 15秒タイムアウト、jma.ts と同じ作法)
// ------------------------------------------
async function fetchJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`川の防災情報が ${res.status} を返しました (${url})`);
  return res.json();
}

// 🔄 マスタ類 (水系一覧・河川一覧・観測所マスタ) の再取得間隔。
// 観測所の新設・改称は稀なため日次で十分 (area.json と同じ考え方)
const MASTER_REFRESH_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------
// 📍 マスタ類のキャッシュ (日次更新)
// ------------------------------------------
// 📌 水系一覧・水系インデックス・観測所マスタは変化が稀なため日次で
// キャッシュする (JmaAreaNameResolver と同じ考え方)。取得に失敗した
// 場合は例外にせず空の結果を返し、観測値の取り込み自体は続ける
// (名前はフォールバック表示になる)。失敗分はキャッシュ時刻を進め
// ないため、次回ポーリングで再試行される
export class KawabouMasterResolver {
  // 🏞️ 全国の水系コード一覧とその取得時刻
  private rsysCodes: number[] = [];
  private rsysCodesAt = 0;
  // 🏞️ 水系コード → 水系インデックス (水系名・河川名) のキャッシュ
  private rsysIndex = new Map<number, { at: number; value: ReturnType<typeof parseRsysIndex> }>();
  // 📍 河川コード → 観測所マスタのキャッシュ
  private riverMasters = new Map<number, { at: number; value: RiverMaster }>();
  private readonly ttlMs: number;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(options: { ttlMs?: number; fetchJson?: (url: string) => Promise<unknown> } = {}) {
    this.ttlMs = options.ttlMs ?? MASTER_REFRESH_MS;
    this.fetchJson = options.fetchJson ?? fetchJsonDefault;
  }

  // 📥 テスト用: 水系コード一覧を直接差し替える
  loadRsysCodes(codes: number[]): void {
    this.rsysCodes = [...codes];
    this.rsysCodesAt = Date.now();
  }

  // 📥 テスト用: 水系インデックスと観測所マスタを直接差し替える
  loadRsysIndex(rsysCode: number, data: unknown): void {
    this.rsysIndex.set(rsysCode, { at: Date.now(), value: parseRsysIndex(data) });
  }
  loadRiverMaster(riverCode: number, data: unknown): void {
    this.riverMasters.set(riverCode, { at: Date.now(), value: parseRvrMaster(data) });
  }

  // 🏞️ 全国の水系コード一覧 (都道府県別インデックスを集約し重複排除)
  async ensureRsysCodes(concurrency = 8): Promise<number[]> {
    if (this.rsysCodes.length > 0 && Date.now() - this.rsysCodesAt < this.ttlMs) return this.rsysCodes;
    const found = new Set<number>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < KAWABOU_PREF_CODES.length) {
        const pref = KAWABOU_PREF_CODES[next++];
        try {
          const data = await this.fetchJson(buildPrefRsysIndexUrl(pref));
          const list = (data as Record<string, any>)?.rsysInfo;
          if (Array.isArray(list)) {
            for (const r of list) {
              const cd = numOrNull(r?.rsysCd);
              if (cd !== null) found.add(cd);
            }
          }
        } catch {
          // ⚠️ 1県の失敗で全体を止めない (その県の水系は次回再試行する)
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, KAWABOU_PREF_CODES.length) }, () => worker()),
    );
    if (found.size > 0) {
      this.rsysCodes = [...found].sort((a, b) => a - b);
      this.rsysCodesAt = Date.now();
    }
    return this.rsysCodes;
  }

  // 🏞️ 水系インデックス (水系名・河川名) を引く。失敗時は空を返す
  async ensureRsysIndex(rsysCode: number): Promise<ReturnType<typeof parseRsysIndex>> {
    const cached = this.rsysIndex.get(rsysCode);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;
    try {
      const value = parseRsysIndex(await this.fetchJson(buildRsysIndexUrl(rsysCode)));
      this.rsysIndex.set(rsysCode, { at: Date.now(), value });
      return value;
    } catch {
      return cached?.value ?? { systemName: "", riverNames: new Map() };
    }
  }

  // 📍 観測所マスタ (河川別) を引く。失敗時は空を返す
  async ensureRiverMaster(riverCode: number): Promise<RiverMaster> {
    const cached = this.riverMasters.get(riverCode);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;
    try {
      const value = parseRvrMaster(await this.fetchJson(buildRvrMasterUrl(riverCode)));
      this.riverMasters.set(riverCode, { at: Date.now(), value });
      return value;
    } catch {
      return cached?.value ?? { stg: new Map(), rn: new Map(), dam: new Map() };
    }
  }
}

// ------------------------------------------
// 🏞️ 全国の現在値の取得 (水系単位の部分成功を許す)
// ------------------------------------------
// 📦 河川スナップショット (ハブが遷移判定つきでストアへ流す形)
export interface RiverSnapshot {
  // 📥 変換済みの河川観測値の下書き (水位・雨量)
  riverDrafts: RiverDraft[];
  // 📥 変換済みのダムの下書き
  damDrafts: DamDraft[];
  // ✅ 現在値の取得に成功した水系の数
  fetchedSystems: number;
  // ❌ 取得に失敗した水系と理由 (その水系は前回状態を保持する)
  failures: { rsysCode: number; message: string }[];
}

// 📦 河川取得のオプション
export interface RiverFetchOptions {
  // 🔄 同時取得数の上限 (1,665水系を一斉に叩かないための抑制)
  concurrency?: number;
  // ⏱️ 1水系の処理ごとに空ける間隔 (ms)。巡回全体の CPU を時間方向へ
  // 分散するための速度制限 (既定0 = 制限なし)
  systemDelayMs?: number;
  // 📍 マスタ解決器 (ハブが保持するものを共有する)
  resolver?: KawabouMasterResolver;
  // 🧪 取得関数の差し替え口 (テスト用)
  fetchJson?: (url: string) => Promise<unknown>;
}

// 🏞️ 現在観測時刻 → 水系一覧 → 水系ごとの現在値、の順に取得し、
// 観測所マスタで名前・基準水位を補って下書きへ変換する。1水系の
// 失敗はその水系だけを failures に記録し、全体は止めない
export async function fetchRiverSnapshot(options: RiverFetchOptions = {}): Promise<RiverSnapshot> {
  const fetchJson = options.fetchJson ?? fetchJsonDefault;
  const resolver = options.resolver ?? new KawabouMasterResolver({ fetchJson });
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 8));
  const systemDelayMs = Math.max(0, Math.trunc(options.systemDelayMs ?? 0));

  const crnt = (await fetchJson(buildTmCrntTimeUrl())) as Record<string, any>;
  const datePath = kawabouDatePath(typeof crnt?.crntObsTime === "string" ? crnt.crntObsTime : "");
  const rsysCodes = await resolver.ensureRsysCodes(concurrency);
  if (rsysCodes.length === 0) throw new Error("水系一覧を取得できませんでした");

  const riverDrafts: RiverDraft[] = [];
  const damDrafts: DamDraft[] = [];
  const failures: { rsysCode: number; message: string }[] = [];
  let fetchedSystems = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rsysCodes.length) {
      const rsysCode = rsysCodes[next++];
      try {
        const tm = await fetchJson(buildRsysTmListUrl(datePath, rsysCode));
        const idx = await resolver.ensureRsysIndex(rsysCode);
        // 📍 現在値に現れた河川のマスタだけを引く (マスタが無い河川は
        // フォールバック名で取り込むため、失敗してもここでは落とさない)
        const masters = new Map<number, RiverMaster>();
        const rvrInfo = (tm as Record<string, any>)?.rvrInfo;
        if (Array.isArray(rvrInfo)) {
          for (const r of rvrInfo) {
            const cd = numOrNull(r?.rvrCd);
            if (cd !== null && !masters.has(cd)) masters.set(cd, await resolver.ensureRiverMaster(cd));
          }
        }
        const converted = convertRsysTmList(tm, {
          systemName: idx.systemName,
          riverNames: idx.riverNames,
          masters,
        });
        riverDrafts.push(...converted.riverDrafts);
        damDrafts.push(...converted.damDrafts);
        fetchedSystems += 1;
      } catch (err) {
        failures.push({
          rsysCode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // ⏱️ 速度制限: 1水系ごとに間隔を空け、巡回の負荷を時間方向へ
      // 分散する (小さなサーバーでイベントループを塞がないための対処)
      if (systemDelayMs > 0 && next < rsysCodes.length) {
        await sleepMs(systemDelayMs);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rsysCodes.length) }, () => worker()));
  return { riverDrafts, damDrafts, fetchedSystems, failures };
}
