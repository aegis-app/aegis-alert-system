// ==========================================
// 🌦️ 気象庁 (警報・注意報 / 台風) の取り込み
// ==========================================
// 📌 気象庁 bosai JSON をポーリングし、Phase 3 の変換器 (convert/jma.ts)
// で共通フォーマットの下書きへ変換する。本ファイルは取得と、区域名の
// 解決器 (area.json のキャッシュを持つ状態持ち部品) を担う。
//   警報: https://www.jma.go.jp/bosai/warning/data/warning/<officeCode>.json
//   台風: https://www.jma.go.jp/bosai/typhoon/data/targetTc.json
//   区域名: https://www.jma.go.jp/bosai/common/const/area.json (class10s)
import { USER_AGENT } from "../util.js";
import {
  ALL_OFFICE_CODES,
  TYPHOON_URL,
  buildWarningUrl,
  parseClass10Names,
  parseTyphoons,
  parseWarningOffice,
} from "../convert/jma.js";
import type { TyphoonDraft, WarningDraft } from "../types.js";

// ------------------------------------------
// 🔄 共通の取得ヘルパー (User-Agent + 15秒タイムアウト)
// ------------------------------------------
async function fetchJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`気象庁が ${res.status} を返しました (${url})`);
  return res.json();
}

// ------------------------------------------
// 📍 区域名の解決器 (area.json の class10s)
// ------------------------------------------
// 🌐 area.json の URL
export const AREA_JSON_URL = "https://www.jma.go.jp/bosai/common/const/area.json";
// 🔄 area.json の再取得間隔 (区域の新設・改称は稀なため日次で十分)
const AREA_REFRESH_MS = 24 * 60 * 60 * 1000;

// 📍 区域名リゾルバ。起動時に area.json を取得してキャッシュし、日次で
// 更新する。取得に失敗しても例外にせず、既存キャッシュ (無ければ
// フォールバック表示) で取り込みを続ける
export class JmaAreaNameResolver {
  // 📍 区域コード → 区域名のキャッシュ
  private names = new Map<string, string>();
  // 🕐 最後に area.json の取得に成功した時刻
  private lastFetchAt = 0;
  // 🔄 取得中はその Promise を共有し、二重取得を避ける
  private inflight: Promise<void> | null = null;
  private readonly ttlMs: number;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(options: { ttlMs?: number; fetchJson?: (url: string) => Promise<unknown> } = {}) {
    this.ttlMs = options.ttlMs ?? AREA_REFRESH_MS;
    this.fetchJson = options.fetchJson ?? fetchJsonDefault;
  }

  // 📥 既にパース済みの area.json データからキャッシュを差し替える (テスト用)
  loadFromData(data: unknown): void {
    this.names = parseClass10Names(data);
    this.lastFetchAt = Date.now();
  }

  // 🔄 キャッシュが古ければ area.json を再取得する。失敗しても投げない
  async ensureLoaded(): Promise<void> {
    if (this.names.size > 0 && Date.now() - this.lastFetchAt < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const names = parseClass10Names(await this.fetchJson(AREA_JSON_URL));
        if (names.size > 0) {
          this.names = names;
          this.lastFetchAt = Date.now();
        }
      } catch {
        // ⚠️ area.json の取得失敗で警報の取り込み全体を止めない。
        // 区域名はフォールバック表示になり、次回ポーリングで再試行する
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  // 📍 区域コードから区域名を引く。解決できなければ undefined
  resolve(areaCode: string): string | undefined {
    return this.names.get(areaCode);
  }
}

// ------------------------------------------
// ⚠️ 警報の全官署取得 (官署単位の部分成功を許す)
// ------------------------------------------
// 📦 警報スナップショット (ハブが store.applyWarningSnapshot へ渡す形)
export interface WarningSnapshot {
  // 📥 取得に成功した官署の下書き一覧 (有効な区域のみ)
  drafts: WarningDraft[];
  // ✅ 取得に成功した官署コードの集合 (差分計算の範囲になる)
  fetchedOfficeCodes: string[];
  // ❌ 取得に失敗した官署と理由 (その官署は前回状態を保持する)
  failures: { officeCode: string; message: string }[];
}

// 📦 警報取得のオプション
export interface WarningFetchOptions {
  // 🏢 対象官署コード (既定は全58官署)
  officeCodes?: readonly string[];
  // 🔄 同時取得数の上限 (58コードを一斉に叩かないための抑制)
  concurrency?: number;
  // 📍 区域名リゾルバ (あれば区域名を area.json 由来で解決する)
  resolver?: JmaAreaNameResolver;
  // 🧪 取得関数の差し替え口 (テスト用)
  fetchJson?: (url: string) => Promise<unknown>;
}

// 🌐 全官署コードを取得し、有効区域の下書きと成功した官署コードを返す。
// 1官署の失敗はその官署だけを failures に記録し、全体は止めない
export async function fetchWarningSnapshot(options: WarningFetchOptions = {}): Promise<WarningSnapshot> {
  const codes = options.officeCodes ?? ALL_OFFICE_CODES;
  const fetchJson = options.fetchJson ?? fetchJsonDefault;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 8));
  if (options.resolver) await options.resolver.ensureLoaded();
  const resolveAreaName = options.resolver
    ? (code: string) => options.resolver!.resolve(code)
    : undefined;

  const drafts: WarningDraft[] = [];
  const fetchedOfficeCodes: string[] = [];
  const failures: { officeCode: string; message: string }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < codes.length) {
      const officeCode = codes[next++];
      try {
        const data = await fetchJson(buildWarningUrl(officeCode));
        drafts.push(...parseWarningOffice(data, officeCode, resolveAreaName));
        fetchedOfficeCodes.push(officeCode);
      } catch (err) {
        failures.push({
          officeCode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, codes.length) }, () => worker()));
  return { drafts, fetchedOfficeCodes, failures };
}

// ------------------------------------------
// 🌀 台風
// ------------------------------------------
// 🌀 台風情報を取得する
export async function fetchTyphoons(
  fetchJson: (url: string) => Promise<unknown> = fetchJsonDefault,
): Promise<TyphoonDraft[]> {
  return parseTyphoons(await fetchJson(TYPHOON_URL));
}
