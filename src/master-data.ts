// ==========================================
// 📚 マスターデータの実データ登録 (静的データセット + AMeDAS)
// ==========================================
// 📌 Aegis ファミリーの観測点・地理マスターデータは A.A.S に集約し、
// GET /v1/master/<name> で配信する (A.A.S が唯一の配布元)。
// 登録の仕組みと索引・配信判断は master.ts (Phase 1) が担い、ここは
// データセット本体を供給者として登録する:
// - 静的データ (data/master/*.json): リポジトリに同梱し、起動時に
//   読み込んでそのまま配信する (原形式を包み直さない)
// - AMeDAS 観測所表: 気象庁の amedastable.json を実行時に取得し、
//   日次で更新してそのまま配信する。初回取得前・取得失敗時は無理に
//   200 を返さず、未用意 (索引で available: false、単体取得で 503)
//   として状態を伝える (master.ts の契約)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logInfo, logWarn, USER_AGENT } from "./util.js";
import type { MasterDataService, MasterDatasetData, MasterDatasetProvider } from "./master.js";

// 📚 静的データセットの定義 (名前 → ファイル名と件数の数え方)。
// 件数は GET /v1/master の索引で使う
interface StaticDatasetDef {
  name: string;
  file: string;
  countOf: (data: Record<string, unknown>) => number;
}

// 🔢 配列フィールドの件数を数える
const arrLen = (key: string) => (data: Record<string, unknown>): number =>
  Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0;
// 🔢 オブジェクトフィールドのキー数を数える
const objLen = (key: string) => (data: Record<string, unknown>): number =>
  data[key] && typeof data[key] === "object" ? Object.keys(data[key] as object).length : 0;

export const STATIC_DATASETS: readonly StaticDatasetDef[] = [
  { name: "stations", file: "stations.json", countOf: arrLen("stations") },
  { name: "station-prefs", file: "station-prefs.json", countOf: objLen("prefs") },
  { name: "tsunami-stations", file: "tsunami-stations.json", countOf: arrLen("stations") },
  { name: "tsunami-zones", file: "tsunami-zones.json", countOf: objLen("zones") },
  { name: "coastline", file: "coastline.json", countOf: objLen("zones") },
  { name: "eew-polygons", file: "eew-polygons.json", countOf: objLen("regions") },
  { name: "volcanoes", file: "volcanoes.json", countOf: arrLen("volcanoes") },
  { name: "rivers", file: "rivers.json", countOf: objLen("rivers") },
];

// 📚 AMeDAS 観測所表の名前 (静的データと並ぶデータセット名)
export const AMEDAS_DATASET_NAME = "amedas";
// 🌐 気象庁 AMeDAS 観測所表 (地点コード → 地点情報のオブジェクト)
export const AMEDAS_TABLE_URL = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json";
// 🔄 AMeDAS 観測所表の再取得間隔 (観測所の新設・廃止は稀なため日次で十分)
const AMEDAS_REFRESH_MS = 24 * 60 * 60 * 1000;

// 🌐 JSON 取得の既定実装 (User-Agent + 15秒タイムアウト)
async function fetchJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`気象庁が ${res.status} を返しました (${url})`);
  return res.json();
}

// 📍 AMeDAS 観測所表の保持者。起動時に取得してキャッシュし、日次で
// 更新する。取得に失敗しても例外にせず、直近の成功内容 (無ければ
// 未取得のまま) で配信を続ける。MasterDatasetProvider として登録され、
// 未取得の間は getData() が null を返す (未用意 = 503 の契約)
export class AmedasTable implements MasterDatasetProvider {
  private body: string | null = null;
  private count = 0;
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(options: { ttlMs?: number; fetchJson?: (url: string) => Promise<unknown> } = {}) {
    this.ttlMs = options.ttlMs ?? AMEDAS_REFRESH_MS;
    this.fetchJson = options.fetchJson ?? fetchJsonDefault;
  }

  // 📥 パース済みの観測所表を取り込む (テスト用と取得成功時の共通経路)。
  // 形式が想定外 (オブジェクトでない・空) なら取り込まず false
  loadFromData(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.length === 0) return false;
    this.body = JSON.stringify(data);
    this.count = keys.length;
    this.fetchedAt = Date.now();
    return true;
  }

  // 🔄 キャッシュが古ければ観測所表を再取得する。失敗しても投げない
  async ensureLoaded(): Promise<void> {
    if (this.body !== null && Date.now() - this.fetchedAt < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const data = await this.fetchJson(AMEDAS_TABLE_URL);
        if (this.loadFromData(data)) {
          logInfo(`AMeDAS 観測所表を取得しました: ${this.count} 件`);
        } else {
          logWarn("AMeDAS 観測所表の形式が想定外のため取り込みませんでした");
        }
      } catch (err) {
        // ⚠️ 取得失敗で配信全体を止めない。直近の成功内容 (無ければ
        // 未取得のまま) で続け、次回に再試行する
        logWarn(
          `AMeDAS 観測所表の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  // ▶️ 初回取得と日次更新を開始する
  start(): void {
    void this.ensureLoaded();
    if (this.timer) return;
    this.timer = setInterval(() => void this.ensureLoaded(), this.ttlMs);
    this.timer.unref?.();
  }

  // ⏹️ 日次更新を止める
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ✅ 配信できる状態かどうか
  get available(): boolean {
    return this.body !== null;
  }

  // 📦 配信データ (未取得なら null = 未用意)
  getData(): MasterDatasetData | null {
    if (this.body === null) return null;
    return {
      body: this.body,
      count: this.count,
      generatedAt: this.fetchedAt > 0 ? new Date(this.fetchedAt).toISOString() : null,
    };
  }
}

// 📥 静的データセットを全て読み込み、レジストリへ登録する。読めない
// ファイルがあっても例外にせず、そのデータセットだけ未登録 (未用意)
// にして他を続ける
export function loadStaticMasterData(master: MasterDataService, dir?: string): void {
  // 📁 既定の置き場所はリポジトリの data/master/ (dist/src/ から見て
  // ../../data/master)。実行時のカレントディレクトリに依存しない
  const baseDir = dir ?? fileURLToPath(new URL("../../data/master", import.meta.url));
  for (const def of STATIC_DATASETS) {
    try {
      const raw = readFileSync(join(baseDir, def.file), "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const generatedAt = typeof data.generatedAt === "string" ? data.generatedAt : null;
      master.registerStatic(def.name, { body: raw, count: def.countOf(data), generatedAt });
    } catch (err) {
      logWarn(
        `マスターデータ ${def.name} (${def.file}) を読み込めませんでした: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const summary = master
    .index()
    .filter((d) => d.name !== AMEDAS_DATASET_NAME)
    .map((d) => `${d.name} ${d.count ?? "-"}`)
    .join(" / ");
  logInfo(`マスターデータを読み込みました: ${summary}`);
}

// 📚 マスターデータの実データを一括で登録する (静的データの読み込みと
// AMeDAS 供給者の登録)。AMeDAS の取得開始 (start) は呼び出し側が行う
export function registerMasterData(
  master: MasterDataService,
  options: {
    dir?: string;
    fetchJson?: (url: string) => Promise<unknown>;
    amedasTtlMs?: number;
  } = {},
): { amedas: AmedasTable } {
  loadStaticMasterData(master, options.dir);
  const amedas = new AmedasTable({ ttlMs: options.amedasTtlMs, fetchJson: options.fetchJson });
  master.register(AMEDAS_DATASET_NAME, amedas);
  return { amedas };
}
