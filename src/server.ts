// ==========================================
// 📡 配信 HTTP サーバー (REST + SSE)
// ==========================================
// 📌 HTTP 層は Node 標準の http のみで実装する (実行時の外部依存ゼロ。
// DESIGN.md 判断記録 1)。取り込み・ストア・変換には触れず、この
// ファイルが HTTP の関心事をすべて担う。
// リスナーは2系統ある:
// - 通常リスナー (createA2sServer): 私設ネットワーク内向け。owner
//   トークンと利用者別トークンの両方を受け付ける。/health と
//   /v1/status/public (無認証の粗い状態) もここだけのものを含む
// - 公開リスナー (createPublicA2sServer): 中継 (Tailscale Funnel 等)
//   の先として 127.0.0.1 に置く限定的な公開提供用。利用者別トークンの
//   み認証可 (owner は拒否)、読み取り系のみ、トークンごとのレート
//   制限つき。加えて EEW は二次利用制限のため原則として届けず、
//   許可リスト + DMDSS 供給の二条件を満たすクライアントにだけ通す
//   (公開 EEW ゲート)
// エンドポイント:
// - GET /health: 無認証の死活確認 (両リスナー)
// - GET /v1/status: 稼働状態 (取り込み経路の健康状態と保持件数)
// - GET /v1/status/public: 無認証の粗い状態 (bosai の表示用、
//   通常リスナーのみ)。イベント内容・エラー詳細は一切含めない
// - GET /v1/events: 直近イベントの一覧 (kind / source / since / limit)
// - GET /v1/stream: SSE。接続時に保持イベントを再生し (since= があれば
//   その時刻以降の更新分だけ)、以後は新規・更新イベントを push する
// - GET /v1/master: マスターデータの索引
// - GET /v1/master/<name>: マスターデータ1件 (原形式のまま)
// 認証はトークン (Authorization: Bearer)。SSE のみ、ヘッダを付け
// られないクライアント向けに ?token= も受ける。
// 認証済みリクエストはアクセスログに記録する (トークンの値は書かない)。
// 公開リスナーでは認証失敗 (401) も identity を伏せて記録する。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AccessLogger } from "./access-log.js";
import type { MasterDataService } from "./master.js";
import type { EventStore } from "./store.js";
import { EVENT_KINDS } from "./types.js";
import type { A2sEvent, EventKind, SourceId } from "./types.js";
import { logWarn } from "./util.js";

// 📡 配信サーバーの依存一式
export interface A2sServerDeps {
  store: EventStore;
  // 🔑 owner トークン。undefined のときは owner 認証なし
  token?: string;
  // 🔑 利用者別トークン (名前 → トークン)。公開リスナーで使えるのはこちらだけ
  clientTokens?: ReadonlyMap<string, string>;
  // 🚧 公開リスナーで EEW を配信してよいクライアント名の集合。
  // 公開リスナーでのみ効き、この集合に名前があり、かつ
  // dmdssConfigured が true のクライアントにだけ eew を通す
  publicEewClients?: ReadonlySet<string>;
  // 🔑 DMDSS の API キーが設定されているか (EEW の供給元が DMDSS か)。
  // 公開 EEW ゲートの条件の片方としてだけ使う
  dmdssConfigured?: boolean;
  // 🏷️ /v1/status に載せる版数
  version: string;
  // 📊 /v1/status の取り込み経路の健康状態を返す関数
  statusProvider: () => Record<string, unknown>;
  // 📝 アクセスログ。未指定なら記録しない
  accessLog?: AccessLogger;
  // 📣 SSE の共有ハブ。2つのリスナーで同じハブを渡すと、配信が両方の
  // 接続へ届く。未指定ならリスナーごとに新規作成する
  sseHub?: SseHub;
  // 🌐 CORS を許可するオリジンの一覧。ブラウザからの取得はここに載る
  // オリジンにだけ許可する。未指定なら既定 (bosai の公開サイトのみ)。
  // 設定は config.ts の A2S_CORS_ORIGINS から渡される
  corsOrigins?: readonly string[];
  // 🚦 公開リスナーのレート制限 (トークンごとに1分あたりの回数)。
  // 公開リスナーでのみ使われる。既定 60
  rateLimitPerMinute?: number;
  // 📚 マスターデータ配信。未指定なら /v1/master 系は 404 にする
  master?: MasterDataService;
}

// 📡 配信サーバーのハンドル
export interface A2sServer {
  server: Server;
  // 📣 このサーバーが使う SSE ハブ (リスナー間共有に使う)
  sseHub: SseHub;
  // 📣 新規・更新イベントを SSE クライアント全員へ送る
  broadcast: (ev: A2sEvent) => void;
  // 🔢 現在の SSE 接続数
  clientCount: () => number;
  close: () => Promise<void>;
}

// 📦 kind の検証は types.ts の EVENT_KINDS を単一の定義として参照する
const KINDS: readonly EventKind[] = EVENT_KINDS;
// 📡 source の検証に使う経路一覧 (types.ts の SourceId と対応)
const SOURCE_IDS: readonly SourceId[] = [
  "p2p",
  "wolfx-ws",
  "wolfx-http",
  "jma",
  "jma-xml",
  "kawabou",
  "wbgt",
  "dmdss",
];
// 💓 SSE の死活確認 (コメント行) の間隔
const SSE_HEARTBEAT_MS = 25000;
// 🚦 SSE の背圧制御: 1接続あたりの未送信フレームの上限と、1フレームの
// 書き込みが詰まったとみなすまでの時間
const SSE_MAX_QUEUED_FRAMES = 100;
const SSE_WRITE_TIMEOUT_MS = 30000;
// 🌐 無認証の粗い状態を返すパス (bosai の A2S 表示用)
const PUBLIC_STATUS_PATH = "/v1/status/public";
// 🌐 死活確認のパス (無認証、両リスナー)
const HEALTH_PATH = "/health";
// 🌐 CORS 許可オリジンの既定値 (bosai の公開サイトのみ)。
// deps.corsOrigins (環境変数 A2S_CORS_ORIGINS) が優先される
const DEFAULT_CORS_ORIGINS: readonly string[] = ["https://bosai.vercel.app"];
// 🌐 公開リスナーで許可するパス (読み取り系のみ。これ以外は 404)
const PUBLIC_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/v1/status",
  "/v1/events",
  "/v1/stream",
  HEALTH_PATH,
]);
// 📚 マスターデータは索引と配下のデータセット名すべてを公開リスナー
// でも許可する (パスが動的なため接頭辞で判定する)
function isPublicAllowedPath(path: string): boolean {
  return PUBLIC_ALLOWED_PATHS.has(path) || path === "/v1/master" || path.startsWith("/v1/master/");
}
// 📚 マスターデータ応答のキャッシュ指示 (CDN・プロキシ向け)
const MASTER_CACHE_CONTROL = "public, max-age=300";
// 🚦 レート制限の既定値 (トークンごとに1分あたり)
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
// 📝 認証失敗をアクセスログに残すときの identity (誰の・どのトークンかは
// 一切残さない)
const UNAUTHENTICATED_IDENTITY = "unauthenticated";

// 📣 SSE の書き込み口。SseHub はこの interface だけに依存する
export interface SseSink {
  // 📨 1フレームを送る (詰まっている場合は内部で間引き・切断する)
  writeFrame: (frame: string) => void;
  // 📨 接続時のスナップショット再生専用の送信。再生は件数が有界な
  // サーバー発のバーストで、滞留ではなく正常な初期送信なので、
  // 未送信フレーム上限の対象にしない (1フレームごとの書き込み
  // タイムアウトによる詰まり検知は従来どおり効く)
  writeBurstFrame: (frame: string) => void;
  // 🚧 この接続へイベントを流してよいかの判定 (任意)。broadcast の
  // 際に接続ごとに評価し、false のイベントはその接続にだけ届けない
  // (公開 EEW ゲート用)。未設定なら全イベントを通す
  acceptsEvent?: (ev: A2sEvent) => boolean;
  // 🛑 接続を閉じる (冪等)
  close: () => void;
  // 🔍 既に閉じているかどうか
  readonly closed: boolean;
}

// 📣 HTTP レスポンスへの SSE 書き込み口。
// 背圧は「未送信フレームの上限 + 書き込みタイムアウト」で制御する:
// 送信は内部キューで直列化し、キューが上限を超えた接続 (詰まったまま
// 回復しないクライアント) は切断する。詰まった1フレームの書き込みが
// 制限時間内に終わらない場合も切断する。切断したクライアントは再接続
// 時のスナップショット再生と since= 回収で回復できるため、イベントを
// 溜め続けるより切る方が安全という判断
export class HttpSseSink implements SseSink {
  // 🚧 接続ごとの配信判定 (公開 EEW ゲート)。接続を受け付けた側が
  // 認証済み identity に応じて設定する
  acceptsEvent?: (ev: A2sEvent) => boolean;
  private queue: string[] = [];
  private pumping = false;
  private isClosed = false;
  private resolveClosed: () => void = () => {};
  // 🔔 接続が閉じたときに待機側 (ストリームハンドラ) を起こす
  readonly closedPromise: Promise<void>;
  // 🔔 閉じたときにハブから自分を外すための通知先
  onClose: (() => void) | null = null;

  constructor(private readonly res: ServerResponse) {
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    // 🔌 クライアント側の切断はレスポンスの close で検知する
    res.on("close", () => this.close());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  writeFrame(frame: string): void {
    this.enqueue(frame, true);
  }

  writeBurstFrame(frame: string): void {
    this.enqueue(frame, false);
  }

  // 📥 送信キューへ積む。enforceCap が true の経路 (ライブ配信) では
  // 未送信フレーム上限を超えたら滞留とみなして切断する。再生バースト
  // (enforceCap: false) は上限の対象外だが、pump 自体は共通なので
  // 書き込みタイムアウトで詰まれば切断される
  private enqueue(frame: string, enforceCap: boolean): void {
    if (this.isClosed) return;
    if (enforceCap && this.queue.length >= SSE_MAX_QUEUED_FRAMES) {
      // 🚦 滞留が上限を超えたら、これ以上溜めずに切断する
      this.close();
      return;
    }
    this.queue.push(frame);
    void this.pump();
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.queue = [];
    this.resolveClosed();
    this.onClose?.();
    try {
      this.res.end();
    } catch {
      // ⚠️ 終了処理中の失敗は無視する
    }
  }

  // 📨 キューを先頭から順に送る (同時に1つだけ動く)
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.isClosed && this.queue.length > 0) {
        const frame = this.queue.shift()!;
        if (!(await this.writeOne(frame))) {
          this.close();
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // ⏱️ 1フレームの書き込み。書き込みコールバックはソケットへ渡し
  // 終わった時点で呼ばれ、戻り値が false (バッファ満杯) の場合も
  // 排出後に呼ばれるため、詰まり検知はコールバック + タイムアウトで足りる。
  // 制限時間内に終わらなければ false
  private writeOne(frame: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(false), SSE_WRITE_TIMEOUT_MS);
      timer.unref?.();
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      try {
        this.res.write(frame, (err) => finish(!err));
      } catch {
        finish(false);
      }
    });
  }
}

// 📣 SSE クライアントの集合と配信・死活確認を担うハブ。
// 2つのリスナーが同じハブを共有すると、片方で受けた接続にも
// もう片方経由の broadcast が届く
export class SseHub {
  private readonly clients = new Set<SseSink>();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  // 💓 heartbeatMs はテスト用に差し替え可能にする (既定は本番値)
  constructor(heartbeatMs: number = SSE_HEARTBEAT_MS) {
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.closed) {
          this.clients.delete(client);
          continue;
        }
        client.writeFrame(`: ping ${Date.now()}\n\n`);
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  add(sink: SseSink): void {
    // 📌 終了済みのハブへの追加は即座に閉じる。終了処理の最中に
    // 再接続してきたクライアントが残ると、その接続がサーバーの
    // close 完了を妨げ続けるため
    if (this.closed) {
      sink.close();
      return;
    }
    this.clients.add(sink);
  }

  remove(sink: SseSink): void {
    this.clients.delete(sink);
  }

  // 📣 1イベントを SSE 形式で全クライアントへ送る
  broadcast(ev: A2sEvent): void {
    const frame = frameOf(ev);
    for (const client of this.clients) {
      if (client.closed) {
        this.clients.delete(client);
        continue;
      }
      // 🚧 接続ごとの配信ゲート (公開 EEW ゲート)。判定が false の
      // イベントは、その接続にだけ黙って届けない
      if (client.acceptsEvent && !client.acceptsEvent(ev)) continue;
      client.writeFrame(frame);
    }
  }

  count(): number {
    return this.clients.size;
  }

  // 🛑 全接続を閉じる (冪等。共有ハブを両リスナーから閉じても安全)
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}

// 📨 イベント1件の SSE フレーム
function frameOf(ev: A2sEvent): string {
  return `event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`;
}

// 🚦 トークンごとの固定ウィンドウ式レート制限 (インメモリ)
class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60000,
  ) {}

  // ✅ 許可されれば true。許可された分だけ数える
  allow(key: string, now: number = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }

  // ⏱️ 現在のウィンドウが終わるまでの秒数 (Retry-After 用)
  retryAfterSec(key: string, now: number = Date.now()): number {
    const w = this.windows.get(key);
    if (!w) return 1;
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
  }
}

// 🔑 トークンの定数時間比較 (長さが違う場合は即 false)
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// 📊 経路の健康状態 (詳細) から、公開用の粗い状態だけを取り出す。
// エラーの文面やポーリング時刻などの詳細は含めず、ok / ng / idle の
// 判定と最終成功・最終受信時刻だけを返す (イベント内容は元々含まない)
type PublicSourceStatus = "ok" | "ng" | "idle";
interface PublicSource {
  status: PublicSourceStatus;
  lastSuccessAt: string | null;
  lastEventAt: string | null;
}

function toPublicSource(health: unknown): PublicSource | null {
  if (!health || typeof health !== "object") return null;
  const h = health as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const lastSuccessAt = str(h.lastSuccessAt);
  const lastErrorAt = str(h.lastErrorAt);
  const lastEventAt = str(h.lastEventAt);
  let status: PublicSourceStatus;
  if (typeof h.connected === "boolean") {
    // 🔌 WebSocket 経路は接続状態そのものが健全性 (切断中は HTTP
    // フォールバックが担うが、この経路としては ng と正直に出す)
    status = h.connected ? "ok" : "ng";
  } else if (lastSuccessAt === null && lastErrorAt === null) {
    // 📌 まだ一度も動いていない経路 (起動直後、WS 接続中は止まっている
    // HTTP フォールバック等) は異常と断定せず idle にする
    status = "idle";
  } else if (lastSuccessAt !== null && (lastErrorAt === null || lastSuccessAt >= lastErrorAt)) {
    status = "ok";
  } else {
    status = "ng";
  }
  return { status, lastSuccessAt, lastEventAt };
}

function toPublicSources(sources: Record<string, unknown>): Record<string, PublicSource> {
  const out: Record<string, PublicSource> = {};
  for (const [name, health] of Object.entries(sources)) {
    const pub = toPublicSource(health);
    if (pub) out[name] = pub;
  }
  return out;
}

// 🌐 リクエストヘッダを1つ取る (文字列でない値は無いものとして扱う)
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

// 📨 JSON 応答を送る
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

// 📨 本文なしの応答を送る (CORS プリフライト用)
function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string>): void {
  if (res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
}

// 🕐 since パラメータ (epoch ミリ秒または ISO 8601) を解釈する。
// 解釈できなければ null、パラメータ自体が無ければ undefined
function parseSinceParam(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const asNum = Number(raw);
  const parsed = Number.isFinite(asNum) && raw.trim() !== "" ? asNum : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// 📡 リスナー本体。isPublic で公開用かどうかを切り替える
function createListener(deps: A2sServerDeps, isPublic: boolean): A2sServer {
  const hub = deps.sseHub ?? new SseHub();
  const clientTokens: ReadonlyMap<string, string> = deps.clientTokens ?? new Map();
  const limiter = isPublic ? new RateLimiter(deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE) : null;
  // 🕐 公開ステータスの稼働時間の起点
  const startedAtMs = Date.now();

  // 🚧 公開 EEW ゲート: EEW は供給元の二次利用制限のため、公開リスナー
  // では原則としてクライアントへ届けない。例外は「許可リスト
  // (A2S_PUBLIC_EEW_CLIENTS) に名前がある」かつ「EEW の供給元が
  // DMDSS (キー設定済み)」の両方を満たすクライアントだけ。通常
  // リスナー (私設ネットワーク内) は従来どおり無条件に届ける
  const publicEewClients: ReadonlySet<string> = deps.publicEewClients ?? new Set();
  const dmdssConfigured = deps.dmdssConfigured === true;
  const canReceiveEew = (identity: string): boolean =>
    !isPublic || (dmdssConfigured && publicEewClients.has(identity));
  // 🚧 ゲートをイベント単位の判定にする (REST / SSE の共通部品)。
  // eew 以外の種別は常に通す
  const visibleTo =
    (identity: string) =>
    (ev: A2sEvent): boolean =>
      ev.kind !== "eew" || canReceiveEew(identity);

  // 🔑 リクエストが提示したトークンの候補を取り出す。
  // Authorization ヘッダを先に、SSE では ?token= も候補に加える
  // (ヘッダが不正でもクエリの正しいトークンで認証できるよう、候補を
  // 順に照合する)
  const presentedTokens = (req: IncomingMessage, url: URL, path: string): string[] => {
    const out: string[] = [];
    const auth = headerValue(req, "authorization");
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const t = auth.slice("Bearer ".length).trim();
      if (t) out.push(t);
    }
    if (path === "/v1/stream") {
      const q = url.searchParams.get("token");
      if (q) out.push(q);
    }
    return out;
  };

  // 🔑 認証判定。成功したら識別子 (owner / クライアント名 / anonymous) を、
  // 失敗したら null を返す。
  // - owner トークンは公開リスナーでは拒否する
  // - トークンが何も設定されていない場合の無認証 (開発用) は通常
  //   リスナーのみ。公開リスナーでは絶対に無認証にしない
  const authenticate = (req: IncomingMessage, url: URL, path: string): string | null => {
    const candidates = presentedTokens(req, url, path);
    for (const presented of candidates) {
      if (deps.token && tokenEquals(presented, deps.token)) {
        // 📌 公開側では owner 候補は一致扱いにしない (次の候補の照合は続ける)
        if (!isPublic) return "owner";
        continue;
      }
      for (const [name, token] of clientTokens) {
        if (tokenEquals(presented, token)) return name;
      }
    }
    if (candidates.length === 0 && !isPublic && !deps.token && clientTokens.size === 0) {
      return "anonymous";
    }
    return null;
  };

  // 🌐 CORS 許可オリジン。設定 (deps.corsOrigins) があればそれを使い、
  // 無ければ既定 (bosai のみ)。許可オリジンからの要求にだけ
  // Access-Control-Allow-Origin を付け、それ以外には付けない
  // (他オリジンのブラウザからは読めないままにする)
  const corsOrigins: readonly string[] =
    deps.corsOrigins && deps.corsOrigins.length > 0 ? deps.corsOrigins : DEFAULT_CORS_ORIGINS;
  const corsHeadersFor = (origin: string | undefined): Record<string, string> =>
    origin && corsOrigins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

  // ----- SSE ストリーム -----
  const handleStream = (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    identity: string,
    cors: Record<string, string>,
  ): void => {
    // 🕐 since= があれば、その時刻以降に更新された保持イベントだけを
    // 再生する (切断からの復帰で全件再生を避ける経路。REST の since=
    // 回収と同じ境界規則: >= で含む)
    const sinceMs = parseSinceParam(url.searchParams.get("since"));
    if (sinceMs === null) {
      sendJson(res, 400, { error: "invalid_since" }, cors);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...cors,
    });
    const sink = new HttpSseSink(res);
    // 🚧 公開 EEW ゲート: ライブ配信 (broadcast) は接続ごとの判定で、
    // スナップショット再生は下のループで、それぞれゲート対象
    // クライアントから eew を黙って除外する
    const accepts = visibleTo(identity);
    sink.acceptsEvent = accepts;
    sink.onClose = () => hub.remove(sink);
    hub.add(sink);
    // 🔌 レスポンス側の close に加え、リクエスト側の終了でも閉じる
    req.on("close", () => sink.close());
    // 📌 接続時は保持イベントを古い順に再生し、以後は broadcast で受ける。
    // river / dam は snapshot() 側で再生から除外される (最新値の参照
    // データで約1.4万件あるため。現在値は REST で参照し、状態遷移は
    // broadcast で届く)
    const replay =
      sinceMs === undefined
        ? deps.store.snapshot()
        : deps.store.snapshot().filter((ev) => Date.parse(ev.updatedAt) >= sinceMs);
    for (const ev of replay) {
      if (!accepts(ev)) continue;
      sink.writeBurstFrame(frameOf(ev));
    }
    sink.writeBurstFrame(`event: ready\ndata: {}\n\n`);
  };

  // ----- リクエスト処理本体 -----
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const path = url.pathname;
    const method = req.method ?? "GET";
    // 🌐 CORS は許可オリジンからの要求にだけ付ける
    const cors = corsHeadersFor(headerValue(req, "origin"));

    // ----- 死活確認 (無認証・両リスナー) -----
    // 📌 認証もメソッド制限も受けない最小の応答。監視や中継の死活
    // 確認に使う。保持件数などの状態は /v1/status (public) の領分
    if (path === HEALTH_PATH && method === "GET") {
      sendJson(res, 200, { ok: true, service: "aegis-alert-system", version: deps.version }, cors);
      return;
    }

    // ----- 公開ステータス (無認証・粗い情報のみ、通常リスナーのみ) -----
    // 📌 認証チェックより前に処理する例外。返すのは稼働時間・保持件数・
    // 経路の ok/ng と最終受信時刻だけで、イベント内容やエラー詳細は
    // 構造的に含まない (toPublicSources で明示的に絞る)
    if (!isPublic && path === PUBLIC_STATUS_PATH) {
      if (method === "OPTIONS") {
        sendEmpty(res, 204, {
          ...cors,
          ...(cors["Access-Control-Allow-Origin"]
            ? { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" }
            : {}),
        });
        return;
      }
      if (method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" }, cors);
        return;
      }
      sendJson(
        res,
        200,
        {
          ok: true,
          service: "aegis-alert-system",
          version: deps.version,
          uptimeSec: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
          counts: deps.store.counts(),
          sources: toPublicSources(deps.statusProvider()),
        },
        cors,
      );
      return;
    }

    // ----- CORS プリフライト -----
    // 🌐 ブラウザ上のクライアントが API を読むための許可。プリフライト
    // (OPTIONS) は認証もメソッド制限も受けないため、後段のガードより
    // 前にここで応える。許可は設定されたオリジンにだけ与え、許可外の
    // オリジンには何も付けない (従来どおり読めない)。公開リスナーでは
    // 許可対象も読み取り系パスに限る (存在を隠す方針とそろえ、それ
    // 以外のパスへのプリフライトは 404 に倒す)
    if (method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) {
        // 📌 許可外オリジンの OPTIONS は従来どおり 405 (メソッド制限と
        // 同じ応答。CORS ヘッダは付けない)
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (isPublic && !isPublicAllowedPath(path)) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      // 📌 プリフライトで要求されたヘッダはそのまま許可する (実際に
      // 送れるのは認証を通過した要求だけであり、許可自体は無害)。
      // 要求が無ければ bosai が使う Authorization を既定にする
      const requested = headerValue(req, "access-control-request-headers");
      sendEmpty(res, 204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": requested && requested.trim() ? requested : "Authorization",
        "Access-Control-Max-Age": "86400",
      });
      return;
    }

    // ----- 公開リスナーの経路制限 (読み取り系以外は存在自体を見せない) -----
    if (isPublic && !isPublicAllowedPath(path)) {
      sendJson(res, 404, { error: "not_found" }, cors);
      return;
    }

    // ----- メソッド制限 (GET のみ) -----
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" }, cors);
      return;
    }

    // ----- 認証 -----
    const identity = authenticate(req, url, path);
    if (identity === null) {
      // 📝 公開リスナーでは認証失敗も記録する。記録するのは時刻・
      // メソッド・パス・401 のみで、提示されたトークンの値や推測
      // 文字列は絶対に残さない (identity は固定文字列にする)。
      // 通常リスナー (私設ネットワーク内) は従来どおり記録しない
      if (isPublic && deps.accessLog) {
        deps.accessLog.log({
          identity: UNAUTHENTICATED_IDENTITY,
          method,
          path,
          status: 401,
        });
      }
      sendJson(res, 401, { error: "unauthorized" }, cors);
      return;
    }

    // 📝 認証済みリクエストは、応答が確定した時点でアクセスログに残す
    // (ステータスは finish 時点のもの。パスはクエリなし、トークンは書かない)
    if (deps.accessLog) {
      const accessLog = deps.accessLog;
      res.on("finish", () => {
        accessLog.log({ identity, method, path, status: res.statusCode });
      });
    }

    // ----- レート制限 (公開リスナーのみ、トークンごと) -----
    if (limiter && !limiter.allow(identity)) {
      sendJson(
        res,
        429,
        { error: "rate_limited" },
        { ...cors, "Retry-After": String(limiter.retryAfterSec(identity)) },
      );
      return;
    }

    // ----- マスターデータ -----
    // 📚 認証は events と同じ (この段は認証・レート制限の後段)。
    // 応答には CDN・プロキシ向けの Cache-Control を付ける
    if (path === "/v1/master") {
      if (!deps.master) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      sendJson(res, 200, { datasets: deps.master.index() }, { ...cors, "Cache-Control": MASTER_CACHE_CONTROL });
      return;
    }
    if (path.startsWith("/v1/master/")) {
      if (!deps.master) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice("/v1/master/".length));
      } catch {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      if (!name || name.includes("/")) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      const result = deps.master.get(name);
      if (result.status === 404) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      if (result.status === 503) {
        // 📌 初回取得前・取得失敗時はこちら (状態が分かる応答)
        sendJson(res, 503, { error: "master_unavailable", dataset: name }, cors);
        return;
      }
      if (!res.writableEnded) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": MASTER_CACHE_CONTROL,
          ...cors,
        });
        res.end(result.body);
      }
      return;
    }

    // ----- 稼働状態 -----
    if (path === "/v1/status") {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: "aegis-alert-system",
          version: deps.version,
          auth: deps.token || clientTokens.size > 0 ? "token" : "none",
          // 🚧 要求したクライアント自身が EEW を受信できる状態か。
          // 通常リスナーでは常に true
          eewDelivery: canReceiveEew(identity),
          sseClients: hub.count(),
          counts: deps.store.counts(),
          sources: deps.statusProvider(),
        },
        cors,
      );
      return;
    }

    // ----- イベント一覧 -----
    if (path === "/v1/events") {
      const kindParam = url.searchParams.get("kind");
      if (kindParam !== null && !KINDS.includes(kindParam as EventKind)) {
        sendJson(res, 400, { error: "invalid_kind" }, cors);
        return;
      }
      const sourceParam = url.searchParams.get("source");
      if (sourceParam !== null && !SOURCE_IDS.includes(sourceParam as SourceId)) {
        sendJson(res, 400, { error: "invalid_source" }, cors);
        return;
      }
      const sinceMs = parseSinceParam(url.searchParams.get("since"));
      if (sinceMs === null) {
        sendJson(res, 400, { error: "invalid_since" }, cors);
        return;
      }
      // 📌 limit の上限はストアの全体保持上限にそろえる (従来の200では
      // 長時間切断したクライアントが保持中の全件を REST でも回収
      // できなかった)
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limitMax = deps.store.totalCapacity;
      const limit = Number.isFinite(limitRaw) ? Math.min(limitMax, Math.max(1, Math.trunc(limitRaw))) : 50;
      // 🚧 公開 EEW ゲート: ゲート対象のクライアントには eew を
      // エラーにせず黙って除外する (kind=eew の単独指定でも、種別を
      // 混ぜた一覧でも同じ)
      const events = deps.store
        .list({
          kind: kindParam ? (kindParam as EventKind) : undefined,
          source: sourceParam ? (sourceParam as SourceId) : undefined,
          sinceMs,
          limit,
        })
        .filter(visibleTo(identity));
      sendJson(res, 200, { events }, cors);
      return;
    }

    // ----- SSE ストリーム -----
    if (path === "/v1/stream") {
      handleStream(req, res, url, identity, cors);
      return;
    }

    sendJson(res, 404, { error: "not_found" }, cors);
  };

  // 🛡️ ハンドラ全体の例外ガード。どの経路で例外が起きてもプロセスは
  // 落とさず、500 {error:"internal"} を返す
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      logWarn(`リクエスト処理で例外が発生しました: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return {
    server,
    sseHub: hub,
    broadcast: (ev) => hub.broadcast(ev),
    clientCount: () => hub.count(),
    close: () =>
      new Promise<void>((resolve) => {
        hub.close();
        server.close(() => resolve());
        // 📌 再接続を繰り返すクライアントが keep-alive 接続を握り続ける
        // と server.close の完了がいつまでも来ないため、残りの接続は
        // 強制的に閉じる
        server.closeAllConnections?.();
      }),
  };
}

// 📡 通常リスナー (私設ネットワーク内向け。owner + 利用者別トークン)
export function createA2sServer(deps: A2sServerDeps): A2sServer {
  return createListener(deps, false);
}

// 📡 公開リスナー (中継先。利用者別トークンのみ、読み取り系のみ、
// レート制限つき。owner トークンは拒否する)
export function createPublicA2sServer(deps: A2sServerDeps): A2sServer {
  return createListener(deps, true);
}
