// ==========================================
// 📚 マスターデータ配信 (観測点・地理データの集約)
// ==========================================
// 📌 Aegis ファミリーの観測点・地理マスターデータは A.A.S に集約し、
// GET /v1/master/<name> で配信する (A.A.S が唯一の配布元)。
// 本モジュールは「登録の仕組みと索引・配信判断」を担い、データセット
// 本体 (静的ファイルの読み込みと AMeDAS の実行時取得) は
// master-data.ts がプロバイダとして登録する。
// 配信形式は各データセットの原形式をそのまま使う (包み直しはしない)。

// 📚 データセットの正規名 (索引の並び順)。静的データセット8件 +
// 実行時取得の AMeDAS 観測所表
export const MASTER_DATASET_NAMES: readonly string[] = [
  "stations",
  "station-prefs",
  "tsunami-stations",
  "tsunami-zones",
  "coastline",
  "eew-polygons",
  "volcanoes",
  "rivers",
  "amedas",
];

// 📚 索引 (GET /v1/master) の1件分
export interface MasterDatasetInfo {
  name: string;
  // 🔢 収録件数。未登録・未取得は null
  count: number | null;
  // 🗓️ データの生成日 (静的データはファイル内の generatedAt、実行時
  // 取得は最終取得時刻の ISO 表記)。不明・未取得は null
  generatedAt: string | null;
  // ✅ そのデータセットが今配信できるか
  available: boolean;
}

// 📦 配信できる状態のデータセット (本文は配信形に直列化済み)
export interface MasterDatasetData {
  // 📦 配信本文 (原形式の JSON 文字列)
  body: string;
  // 🔢 収録件数
  count: number | null;
  // 🗓️ 生成日。不明は null
  generatedAt: string | null;
}

// 📥 データセットの供給者。データが用意できていない間は null を返す
// (索引では available: false、単体取得では 503 になる)
export interface MasterDatasetProvider {
  getData(): MasterDatasetData | null;
}

// 📚 マスターデータ全体の保持・配信判断。データセットは名前で登録し、
// 索引は正規名の並びで返す
export class MasterDataService {
  private readonly providers = new Map<string, MasterDatasetProvider>();

  // 📥 データセットの供給者を登録する (同名は後勝ちで置き換える)
  register(name: string, provider: MasterDatasetProvider): void {
    this.providers.set(name, provider);
  }

  // 📥 静的な本文をそのまま配信するデータセットを登録する
  registerStatic(name: string, data: MasterDatasetData): void {
    this.register(name, { getData: () => data });
  }

  // 📚 索引 (GET /v1/master の中身)。正規名の並び + 正規名以外の
  // 登録分 (登録順)。未登録の正規名は available: false で載せる
  // (クライアントが「まだ無い」ことを索引で判断できるようにする)
  index(): MasterDatasetInfo[] {
    const names = [...MASTER_DATASET_NAMES];
    for (const name of this.providers.keys()) {
      if (!names.includes(name)) names.push(name);
    }
    return names.map((name) => {
      const data = this.providers.get(name)?.getData() ?? null;
      return data
        ? { name, count: data.count, generatedAt: data.generatedAt, available: true }
        : { name, count: null, generatedAt: null, available: false };
    });
  }

  // 📦 データセット1件の配信判断。200 なら本文、正規名でも登録名でも
  // ない名前は 404、知っている名前でデータが未用意なら 503
  // (状態が分かる応答にする)
  get(name: string): { status: 200; body: string } | { status: 404 } | { status: 503 } {
    const provider = this.providers.get(name);
    if (!provider) {
      return MASTER_DATASET_NAMES.includes(name) ? { status: 503 } : { status: 404 };
    }
    const data = provider.getData();
    if (!data) return { status: 503 };
    return { status: 200, body: data.body };
  }
}
