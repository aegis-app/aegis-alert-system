// ==========================================
// 🎛️ ハブ (取り込みの統括)
// ==========================================
// 📌 P2P ポーリング (551 / 552 / 556)、Wolfx WebSocket、Wolfx HTTP
// フォールバック (WS 切断中のみ)、DMDSS WebSocket (API キー設定時のみ)、
// 気象庁 (警報・注意報 / 台風 / 防災情報XML)、川の防災情報、環境省 WBGT
// を束ね、変換済みイベントをストアへ流す。ストアが新規 / 更新と判定
// したものだけを onEvent で配信側へ渡す。
// 各経路の健康状態 (最終成功・最終受信・最終エラー) を保持し、
// /v1/status へ提供する。
import { fetchP2pHistory } from "./sources/p2p.js";
import { fetchWolfxEew } from "./sources/wolfx.js";
import { WolfxWsClient, type WolfxSocketFactory } from "./sources/wolfx-ws.js";
import {
  fetchTyphoons,
  fetchWarningSnapshot,
  JmaAreaNameResolver,
  type WarningSnapshot,
} from "./sources/jma.js";
import {
  JMA_XML_EQVOL_FEED_URL,
  JMA_XML_EXTRA_FEED_URL,
  JmaXmlSource,
  type JmaXmlPollResult,
} from "./sources/jma-xml.js";
import {
  fetchRiverSnapshot,
  KawabouMasterResolver,
  type RiverSnapshot,
} from "./sources/kawabou.js";
import { fetchHeatSnapshot } from "./sources/wbgt.js";
import {
  DmdssWsClient,
  type DmdssSocketFactory,
  type DmdssStartSocketFn,
} from "./sources/dmdss-ws.js";
import { logInfo, logWarn } from "./util.js";
import type { EventStore } from "./store.js";
import type {
  A2sEvent,
  DamEvent,
  EventDraft,
  HeatDraft,
  RiverEvent,
  SourceId,
  TyphoonDraft,
} from "./types.js";

// 📦 ハブの生成オプション (間隔はすべて省略時に既定値が入る)
export interface HubOptions {
  // ⏱️ ポーリング間隔 (ms)。既定は P2P EEW 15秒 / 地震 30秒 / 津波 30秒 /
  // Wolfx HTTP フォールバック 20秒、気象庁 警報 60秒 / 台風 300秒
  p2pEewIntervalMs?: number;
  p2pQuakeIntervalMs?: number;
  p2pTsunamiIntervalMs?: number;
  wolfxHttpIntervalMs?: number;
  jmaWarningIntervalMs?: number;
  jmaTyphoonIntervalMs?: number;
  // ⏱️ 気象庁防災情報XML フィードのポーリング間隔 (ms)。既定60秒
  // (フィードは毎分更新)
  jmaXmlIntervalMs?: number;
  // ⏱️ 川の防災情報 (河川観測値・ダム) のポーリング間隔 (ms)。元データ
  // の10分粒度に合わせ既定600000 (10分)。⚠️ 0 は河川取り込みの無効化
  // (巡回負荷対策。恒久対策が入るまで本番では 0 のままにする)
  riverIntervalMs?: number;
  // 🔄 川の防災情報の巡回の同時取得数 (既定8) と1水系ごとの間隔
  // (ms、既定0)。巡回の速度制限
  riverConcurrency?: number;
  riverSystemDelayMs?: number;
  // ⏱️ 熱中症警戒アラート (環境省 WBGT) のポーリング間隔 (ms)。
  // 発表は5時/10時/14時/17時のため既定1800000 (30分)
  heatIntervalMs?: number;
  // 💾 気象庁防災情報XML の既読ファイルのパス
  jmaXmlSeenFile?: string;
  // 📣 新規・更新イベントの受け渡し先 (通常は SSE の broadcast)
  onEvent: (ev: A2sEvent) => void;
  // 🧪 テスト用に Wolfx WS クライアントを差し替え可能にする
  wolfxWsClient?: WolfxWsClient;
  // 🧪 テスト用に Wolfx WS のソケット生成を差し替え可能にする
  // (クライアント自体は通常どおり生成し、ハブ側の結線を保ったまま使う)
  wolfxSocketFactory?: WolfxSocketFactory;
  // 🧪 テスト用に各経路の取得関数を差し替え可能にする
  p2pFetcher?: (code: 551 | 552 | 556, limit: number, offset?: number) => Promise<EventDraft[]>;
  wolfxHttpFetcher?: () => Promise<EventDraft | null>;
  warningFetcher?: () => Promise<WarningSnapshot>;
  typhoonFetcher?: () => Promise<TyphoonDraft[]>;
  // 🧪 テスト用に気象庁防災情報XML のソース自体を差し替え可能にする
  // (既読集合などの状態ごと差し替える)
  jmaXmlSource?: JmaXmlSource;
  // 🧪 テスト用に気象庁防災情報XML のフィード取得関数を差し替え可能にする
  jmaXmlFetcher?: (feedUrl: string) => Promise<JmaXmlPollResult>;
  // 🧪 テスト用に川の防災情報の取得関数を差し替え可能にする
  riverFetcher?: () => Promise<RiverSnapshot>;
  // 🧪 テスト用に熱中症アラートの取得関数を差し替え可能にする。
  // ファイルが取得できない場合は null を返す契約
  heatFetcher?: () => Promise<HeatDraft[] | null>;
  // 🔑 DMDSS (Project DM-D.S.S) の API キー。設定されている場合のみ
  // DMDSS WebSocket 取り込みを開始する。未設定なら取り込みは完全に
  // 無効で、現行の P2P + Wolfx の動作に一切影響しない
  dmdssApiKey?: string;
  // 📋 DMDSS で購読する区分の一覧。未指定・空なら既定の区分
  // (現行契約は EEW（予報）のみ。設定側で絞って渡す)
  dmdssClassifications?: string[];
  // 🧪 テスト用に DMDSS WS クライアントを差し替え可能にする
  dmdssWsClient?: DmdssWsClient;
  // 🧪 テスト用に DMDSS WS のソケット生成と Socket Start を差し替え
  // 可能にする (クライアント自体は通常どおり生成する)
  dmdssSocketFactory?: DmdssSocketFactory;
  dmdssStartSocket?: DmdssStartSocketFn;
}

// 📊 経路別の健康状態 (/v1/status の sources に載る形)
export interface SourceHealth {
  // 🕐 最後にポーリング / 接続処理を行った時刻
  lastPollAt: string | null;
  // ✅ 最後に取得が成功した時刻
  lastSuccessAt: string | null;
  // 📥 最後にイベント (下書き) を受け取った時刻
  lastEventAt: string | null;
  // ❌ 最後のエラーの内容と時刻
  lastError: string | null;
  lastErrorAt: string | null;
  // 🔌 WebSocket のみ: 現在接続中かどうか
  connected?: boolean;
}

// 📊 健康状態の初期値 (未実施はすべて null)
const newHealth = (): SourceHealth => ({
  lastPollAt: null,
  lastSuccessAt: null,
  lastEventAt: null,
  lastError: null,
  lastErrorAt: null,
});

// 📊 健康状態を持つ経路のキー (/v1/status の sources のキーと一致させる)
type HealthKey =
  | "p2p551"
  | "p2p552"
  | "p2p556"
  | "wolfxWs"
  | "wolfxHttp"
  | "jmaWarning"
  | "jmaTyphoon"
  | "jmaXmlExtra"
  | "jmaXmlEqvol"
  | "river"
  | "heat"
  | "dmdssWs";

// 🎛️ 取り込みハブ
export class Hub {
  private readonly store: EventStore;
  private readonly onEvent: (ev: A2sEvent) => void;
  private readonly intervals: Required<
    Pick<
      HubOptions,
      | "p2pEewIntervalMs"
      | "p2pQuakeIntervalMs"
      | "p2pTsunamiIntervalMs"
      | "wolfxHttpIntervalMs"
      | "jmaWarningIntervalMs"
      | "jmaTyphoonIntervalMs"
      | "jmaXmlIntervalMs"
      | "riverIntervalMs"
      | "heatIntervalMs"
    >
  >;
  // ⏱️ 稼働中のポーリングタイマー
  private timers: NodeJS.Timeout[] = [];
  // 🔄 実行中のポーリング名 (重ねて走らせないための記録)
  private running = new Set<string>();
  private stopped = true;
  // 📊 経路別の健康状態
  private readonly health: Record<HealthKey, SourceHealth> = {
    p2p551: newHealth(),
    p2p552: newHealth(),
    p2p556: newHealth(),
    wolfxWs: { ...newHealth(), connected: false },
    wolfxHttp: newHealth(),
    jmaWarning: newHealth(),
    jmaTyphoon: newHealth(),
    jmaXmlExtra: newHealth(),
    jmaXmlEqvol: newHealth(),
    river: newHealth(),
    heat: newHealth(),
    dmdssWs: { ...newHealth(), connected: false },
  };
  private readonly wolfxWs: WolfxWsClient;
  // 🌐 DMDSS WS クライアント。API キー未設定 (または差し替えなし) の
  // ときは null で、取り込み自体が存在しない
  private readonly dmdssWs: DmdssWsClient | null;
  // 📌 Wolfx HTTP フォールバックが有効かどうか (WS 切断中のみ true)
  private wolfxHttpActive = true;
  // 📍 警報の区域名リゾルバ (area.json のキャッシュを持つ)
  private readonly areaResolver = new JmaAreaNameResolver();
  // 🧪 差し替え可能な取得関数一式 (既定は実取得)
  private readonly fetchers: {
    p2p: NonNullable<HubOptions["p2pFetcher"]>;
    wolfxHttp: NonNullable<HubOptions["wolfxHttpFetcher"]>;
    warning: NonNullable<HubOptions["warningFetcher"]>;
    typhoon: NonNullable<HubOptions["typhoonFetcher"]>;
    jmaXml: NonNullable<HubOptions["jmaXmlFetcher"]>;
    river: NonNullable<HubOptions["riverFetcher"]>;
    heat: NonNullable<HubOptions["heatFetcher"]>;
  };
  // 📡 気象庁防災情報XML ソース (既読集合の状態を持つ)
  private readonly jmaXml: JmaXmlSource;
  // 📍 川の防災情報のマスタキャッシュ (日次更新)
  private readonly kawabouResolver = new KawabouMasterResolver();

  constructor(store: EventStore, options: HubOptions) {
    this.store = store;
    this.onEvent = options.onEvent;
    this.intervals = {
      p2pEewIntervalMs: options.p2pEewIntervalMs ?? 15000,
      p2pQuakeIntervalMs: options.p2pQuakeIntervalMs ?? 30000,
      p2pTsunamiIntervalMs: options.p2pTsunamiIntervalMs ?? 30000,
      wolfxHttpIntervalMs: options.wolfxHttpIntervalMs ?? 20000,
      jmaWarningIntervalMs: options.jmaWarningIntervalMs ?? 60000,
      jmaTyphoonIntervalMs: options.jmaTyphoonIntervalMs ?? 300000,
      jmaXmlIntervalMs: options.jmaXmlIntervalMs ?? 60000,
      riverIntervalMs: options.riverIntervalMs ?? 600000,
      heatIntervalMs: options.heatIntervalMs ?? 1800000,
    };
    this.jmaXml =
      options.jmaXmlSource ?? new JmaXmlSource({ seenFilePath: options.jmaXmlSeenFile });
    this.fetchers = {
      p2p: options.p2pFetcher ?? ((code, limit, offset) => fetchP2pHistory(code, limit, offset)),
      wolfxHttp: options.wolfxHttpFetcher ?? (() => fetchWolfxEew()),
      warning:
        options.warningFetcher ??
        (() => fetchWarningSnapshot({ resolver: this.areaResolver })),
      typhoon: options.typhoonFetcher ?? (() => fetchTyphoons()),
      jmaXml: options.jmaXmlFetcher ?? ((feedUrl) => this.jmaXml.pollFeed(feedUrl)),
      river:
        options.riverFetcher ??
        (() =>
          fetchRiverSnapshot({
            resolver: this.kawabouResolver,
            concurrency: options.riverConcurrency ?? 8,
            systemDelayMs: options.riverSystemDelayMs ?? 0,
          })),
      heat: options.heatFetcher ?? (() => fetchHeatSnapshot()),
    };
    this.wolfxWs =
      options.wolfxWsClient ??
      new WolfxWsClient({
        createSocket: options.wolfxSocketFactory,
        onEew: (draft) => {
          this.health.wolfxWs.lastEventAt = new Date().toISOString();
          this.ingest(draft, "wolfx-ws");
        },
        onActivity: () => {
          this.health.wolfxWs.lastSuccessAt = new Date().toISOString();
        },
        onStateChange: (connected) => {
          this.health.wolfxWs.connected = connected;
          // 📌 WS がつながっている間は HTTP フォールバックを止める
          this.wolfxHttpActive = !connected;
        },
        log: (msg) => logInfo(msg),
        warn: (msg) => logWarn(msg),
      });
    // 🌐 DMDSS は API キーが設定されている場合のみクライアントを作る
    // (未設定なら取り込みは完全に無効)
    this.dmdssWs =
      options.dmdssWsClient ??
      (options.dmdssApiKey
        ? new DmdssWsClient({
            apiKey: options.dmdssApiKey,
            classifications: options.dmdssClassifications,
            startSocket: options.dmdssStartSocket,
            createSocket: options.dmdssSocketFactory,
            onDraft: (draft) => {
              this.health.dmdssWs.lastEventAt = new Date().toISOString();
              this.ingest(draft, "dmdss");
            },
            onActivity: () => {
              this.health.dmdssWs.lastSuccessAt = new Date().toISOString();
            },
            onStateChange: (connected) => {
              this.health.dmdssWs.connected = connected;
            },
            log: (msg) => logInfo(msg),
            warn: (msg) => logWarn(msg),
          })
        : null);
  }

  // 🚀 取り込みを開始する
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wolfxWs.start();
    this.dmdssWs?.start();
    // 📌 初回は即時に取り込み、以後は間隔で繰り返す
    this.pollLoop("p2p556", this.intervals.p2pEewIntervalMs, () => this.pollP2p(556, 20, "p2p556"));
    this.pollLoop("p2p551", this.intervals.p2pQuakeIntervalMs, () => this.pollP2p(551, 20, "p2p551"));
    this.pollLoop("p2p552", this.intervals.p2pTsunamiIntervalMs, () => this.pollP2p(552, 5, "p2p552"));
    this.pollLoop("wolfxHttp", this.intervals.wolfxHttpIntervalMs, () => this.pollWolfxHttp());
    this.pollLoop("jmaWarning", this.intervals.jmaWarningIntervalMs, () => this.pollJmaWarnings());
    this.pollLoop("jmaTyphoon", this.intervals.jmaTyphoonIntervalMs, () => this.pollJmaTyphoon());
    this.pollLoop("jmaXmlExtra", this.intervals.jmaXmlIntervalMs, () =>
      this.pollJmaXml(JMA_XML_EXTRA_FEED_URL, "jmaXmlExtra"),
    );
    this.pollLoop("jmaXmlEqvol", this.intervals.jmaXmlIntervalMs, () =>
      this.pollJmaXml(JMA_XML_EQVOL_FEED_URL, "jmaXmlEqvol"),
    );
    // 📌 間隔 0 は河川取り込みの無効化。巡回負荷でイベントループが
    // 塞がり API が無応答化した経緯があるため、止める手段を用意した。
    // 無効化しても保持済みの river / dam イベントの配信は続ける。
    // ⚠️ 恒久対策 (分割巡回) が入るまで有効化しない
    if (this.intervals.riverIntervalMs > 0) {
      this.pollLoop("river", this.intervals.riverIntervalMs, () => this.pollRiver());
    }
    this.pollLoop("heat", this.intervals.heatIntervalMs, () => this.pollHeat());
    logInfo(
      `取り込みを開始しました (P2P 551/552/556 + Wolfx WS/HTTP${this.dmdssWs ? " + DMDSS" : ""} + 気象庁 警報/台風/XML${
        this.intervals.riverIntervalMs > 0 ? " + 川の防災情報" : " (川の防災情報は無効)"
      } + 熱中症)`,
    );
  }

  // 🛑 取り込みを止める
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.wolfxWs.stop();
    this.dmdssWs?.stop();
  }

  // 📊 /v1/status 用の健康状態
  status(): Record<string, SourceHealth> {
    return this.health;
  }

  // 🔄 一定間隔で処理を繰り返す (前回が終わっていない場合は重ねない)
  private pollLoop(name: string, intervalMs: number, fn: () => Promise<void>): void {
    const run = (): void => {
      if (this.stopped || this.running.has(name)) return;
      this.running.add(name);
      void fn()
        .catch(() => undefined) // エラーは各処理内で健康状態へ記録済み
        .finally(() => this.running.delete(name));
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  // 📥 P2P の1経路を取り込む
  private async pollP2p(code: 551 | 552 | 556, limit: number, healthKey: "p2p551" | "p2p552" | "p2p556"): Promise<void> {
    const h = this.health[healthKey];
    h.lastPollAt = new Date().toISOString();
    try {
      const drafts = await this.fetchers.p2p(code, limit, 0);
      // 🌍 551 (地震) は窓 (limit 20) を溢れた電文が二度と取り込まれない
      // 問題 (総点検 L6) への対策として、1ページ目が満杯のときだけ
      // offset ページングで2ページ目 (21〜40件目) まで広げる
      if (code === 551 && drafts.length >= limit) {
        drafts.push(...(await this.fetchers.p2p(code, limit, limit)));
      }
      h.lastSuccessAt = new Date().toISOString();
      h.lastError = null;
      if (drafts.length > 0) h.lastEventAt = new Date().toISOString();
      for (const draft of drafts) this.ingest(draft, "p2p");
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`P2P ${code} の取得に失敗しました: ${h.lastError}`);
    }
  }

  // 📥 Wolfx HTTP フォールバック (WS 切断中のみ)
  private async pollWolfxHttp(): Promise<void> {
    if (!this.wolfxHttpActive) return;
    const h = this.health.wolfxHttp;
    h.lastPollAt = new Date().toISOString();
    try {
      const draft = await this.fetchers.wolfxHttp();
      h.lastSuccessAt = new Date().toISOString();
      h.lastError = null;
      if (draft) {
        h.lastEventAt = new Date().toISOString();
        this.ingest(draft, "wolfx-http");
      }
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`Wolfx HTTP の取得に失敗しました: ${h.lastError}`);
    }
  }

  // ⚠️ 気象庁 警報・注意報を取り込む (有効集合のスナップショット適用)。
  // 官署単位の部分成功を許し、取得に成功した官署が1つでもあれば
  // lastSuccessAt を更新する。全官署が失敗した場合のみ差分を適用しない
  private async pollJmaWarnings(): Promise<void> {
    const h = this.health.jmaWarning;
    h.lastPollAt = new Date().toISOString();
    try {
      const snapshot = await this.fetchers.warning();
      if (snapshot.fetchedOfficeCodes.length === 0) {
        // ❌ 全滅した場合は前回状態を保持し、解除と誤認させない
        const first = snapshot.failures[0];
        throw new Error(first ? `全官署の取得に失敗しました (例: ${first.officeCode}: ${first.message})` : "警報の取得に失敗しました");
      }
      h.lastSuccessAt = new Date().toISOString();
      if (snapshot.failures.length > 0) {
        // ⚠️ 部分失敗: 成功分は取り込むが、失敗した官署があることは健康状態に残す
        h.lastError = `${snapshot.failures.length} 官署の取得に失敗しました: ${snapshot.failures.map((f) => f.officeCode).join(", ")}`;
        h.lastErrorAt = new Date().toISOString();
        logWarn(`気象庁 警報: ${h.lastError} (失敗した官署は前回状態を保持します)`);
      } else {
        h.lastError = null;
      }
      const results = this.store.applyWarningSnapshot(snapshot.drafts, snapshot.fetchedOfficeCodes, "jma");
      if (snapshot.drafts.length > 0 || results.length > 0) h.lastEventAt = new Date().toISOString();
      for (const r of results) {
        logInfo(
          `イベント${r.change === "new" ? "新規" : "更新"}: ${r.event.kind} ${r.event.key} (jma)`,
        );
        this.onEvent(r.event);
      }
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`気象庁 警報の取得に失敗しました: ${h.lastError}`);
    }
  }

  // 🌀 気象庁 台風を取り込む
  private async pollJmaTyphoon(): Promise<void> {
    const h = this.health.jmaTyphoon;
    h.lastPollAt = new Date().toISOString();
    try {
      const drafts = await this.fetchers.typhoon();
      h.lastSuccessAt = new Date().toISOString();
      h.lastError = null;
      if (drafts.length > 0) h.lastEventAt = new Date().toISOString();
      for (const draft of drafts) this.ingest(draft, "jma");
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`気象庁 台風の取得に失敗しました: ${h.lastError}`);
    }
  }

  // 📡 気象庁防災情報XML フィード (随時 / 地震火山) を取り込む。
  // 健康状態はフィード別に持つ。フィード自体の取得に失敗した場合は
  // 差分を適用しない。本文取得に失敗した entry はソース側で既読に
  // なっておらず、次回ポーリングで再試行される。土砂災害警戒情報は
  // 完全集合型のため、取得に成功した都道府県の範囲だけで
  // applySedimentSnapshot の差分を適用する (失敗した都道府県・
  // フィードは前回状態を保持し、全解除に見せない)
  private async pollJmaXml(feedUrl: string, healthKey: "jmaXmlExtra" | "jmaXmlEqvol"): Promise<void> {
    const h = this.health[healthKey];
    h.lastPollAt = new Date().toISOString();
    try {
      const result = await this.fetchers.jmaXml(feedUrl);
      h.lastSuccessAt = new Date().toISOString();
      if (result.failures.length > 0) {
        // ⚠️ 本文取得の失敗はフィード全体の失敗ではないが、再試行が
        // 続いていることは健康状態に残す
        h.lastError = `${result.failures.length} 件の電文取得に失敗しました (次回再試行します)`;
        h.lastErrorAt = new Date().toISOString();
        logWarn(`気象庁 XML (${healthKey}): ${h.lastError}`);
      } else {
        h.lastError = null;
      }
      if (result.fetchedEntries > 0) h.lastEventAt = new Date().toISOString();
      for (const draft of result.drafts) this.ingest(draft, "jma-xml");
      if (result.sedimentPrefs.length > 0) {
        const results = this.store.applySedimentSnapshot(
          result.sedimentDrafts,
          result.sedimentPrefs,
          "jma-xml",
        );
        for (const r of results) {
          logInfo(
            `イベント${r.change === "new" ? "新規" : "更新"}: ${r.event.kind} ${r.event.key} (jma-xml)`,
          );
          this.onEvent(r.event);
        }
      }
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`気象庁 XML (${healthKey}) の取得に失敗しました: ${h.lastError}`);
    }
  }

  // 🏞️ 川の防災情報 (河川観測値・ダム) を取り込む (スナップショット型)。
  // ストアには全観測所の最新値を常に取り込むが、SSE へ配信するのは
  // 状態遷移のときだけ:
  // - 水位・雨量: levelState の変化 (立ち上がり・下降・解消の両方)。
  //   新規観測所は、初回から基準水位超過・欠測以外の異常状態
  //   (stateSeverity > 0) の場合だけ配信する (平常の初回観測まで
  //   流すと全国約1.4万件が初回ポーリングで一斉配信になってしまう)
  // - ダム: 放流の開始/停止 (discharging の遷移)。新規ダムは放流中の
  //   場合だけ配信する (同上の理由)
  // 10分ごとの数値変化そのものは配信しない。水系単位の部分失敗では
  // 失敗した水系の観測所は差分対象にせず、前回値を保持する (ストアへ
  // 流さなければ自然に残る)。全水系が失敗した場合のみ全体を失敗とする
  private async pollRiver(): Promise<void> {
    const h = this.health.river;
    h.lastPollAt = new Date().toISOString();
    try {
      const snapshot = await this.fetchers.river();
      if (snapshot.fetchedSystems === 0) {
        const first = snapshot.failures[0];
        throw new Error(
          first
            ? `全水系の取得に失敗しました (例: ${first.rsysCode}: ${first.message})`
            : "河川観測値の取得に失敗しました",
        );
      }
      h.lastSuccessAt = new Date().toISOString();
      if (snapshot.failures.length > 0) {
        h.lastError = `${snapshot.failures.length} 水系の取得に失敗しました: ${snapshot.failures
          .slice(0, 5)
          .map((f) => f.rsysCode)
          .join(", ")}${snapshot.failures.length > 5 ? " ほか" : ""}`;
        h.lastErrorAt = new Date().toISOString();
        logWarn(`川の防災情報: ${h.lastError} (失敗した水系は前回状態を保持します)`);
      } else {
        h.lastError = null;
      }
      if (snapshot.riverDrafts.length > 0 || snapshot.damDrafts.length > 0) {
        h.lastEventAt = new Date().toISOString();
      }
      // 🌊 河川観測値: 取り込み前後で levelState を比較し、遷移時だけ配信する
      for (const draft of snapshot.riverDrafts) {
        const before = this.store.getEvent(draft.key) as RiverEvent | undefined;
        const result = this.store.ingest(draft, "kawabou");
        const after = result.event as RiverEvent;
        const transitioned = before
          ? before.levelState !== after.levelState
          : after.stateSeverity > 0;
        if (transitioned && result.change !== "none") {
          logInfo(`イベント${result.change === "new" ? "新規" : "更新"}: river ${after.key} 状態=${after.levelState} (kawabou)`);
          this.onEvent(after);
        }
      }
      // 🏞️ ダム: 放流の開始/停止の遷移だけを配信する
      for (const draft of snapshot.damDrafts) {
        const before = this.store.getEvent(draft.key) as DamEvent | undefined;
        const result = this.store.ingest(draft, "kawabou");
        const after = result.event as DamEvent;
        const transitioned = (before?.discharging ?? false) !== after.discharging;
        if (transitioned && result.change !== "none") {
          logInfo(`イベント${result.change === "new" ? "新規" : "更新"}: dam ${after.key} 放流=${after.discharging ? "開始" : "停止"} (kawabou)`);
          this.onEvent(after);
        }
      }
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`川の防災情報の取得に失敗しました: ${h.lastError}`);
    }
  }

  // 🌡️ 熱中症警戒アラート (環境省 WBGT) を取り込む (有効集合型)。
  // ファイルが取得できた場合のみスナップショットを適用する。取得
  // できない場合 (季節外は当日ファイル自体が無い) は前回状態を保持し、
  // 全解除に見せない。季節外は異常ではないため、健康状態には最終
  // ポーリングだけを残し、エラーとしては扱わない
  private async pollHeat(): Promise<void> {
    const h = this.health.heat;
    h.lastPollAt = new Date().toISOString();
    try {
      const drafts = await this.fetchers.heat();
      if (drafts === null) {
        logInfo("熱中症アラート: 発表ファイルを取得できませんでした (季節外の可能性があります。前回状態を保持します)");
        return;
      }
      h.lastSuccessAt = new Date().toISOString();
      h.lastError = null;
      const results = this.store.applyHeatSnapshot(drafts, ["wbgt-alert"], "wbgt");
      if (drafts.length > 0 || results.length > 0) h.lastEventAt = new Date().toISOString();
      for (const r of results) {
        logInfo(
          `イベント${r.change === "new" ? "新規" : "更新"}: ${r.event.kind} ${r.event.key} (wbgt)`,
        );
        this.onEvent(r.event);
      }
    } catch (err) {
      h.lastError = err instanceof Error ? err.message : String(err);
      h.lastErrorAt = new Date().toISOString();
      logWarn(`熱中症アラートの取得に失敗しました: ${h.lastError}`);
    }
  }

  // 📥 下書きをストアへ流し、新規・更新なら配信側へ渡す
  private ingest(draft: EventDraft, source: SourceId): void {
    const result = this.store.ingest(draft, source);
    if (result.change !== "none") {
      logInfo(
        `イベント${result.change === "new" ? "新規" : "更新"}: ${result.event.kind} ${result.event.key} (${source})`,
      );
      this.onEvent(result.event);
    }
  }
}
