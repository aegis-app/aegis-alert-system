// ==========================================
// 🧪 テスト: ハブ (ポーリング結線・WS フォールバック切替・スナップショット適用)
// ==========================================
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Hub } from "../src/hub.js";
import { EventStore } from "../src/store.js";
import { createA2sServer } from "../src/server.js";
import { parseWarningOffice } from "../src/convert/jma.js";
import type { WarningSnapshot } from "../src/sources/jma.js";
import { formatP2pTime } from "../src/util.js";
import { FakeSocket, sleep } from "./fake-socket.js";
import type { A2sEvent, DamDraft, RiverDraft } from "../src/types.js";
import type { WolfxWsClient } from "../src/sources/wolfx-ws.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}
function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

const emptyWarning: WarningSnapshot = { drafts: [], fetchedOfficeCodes: ["130000"], failures: [] };
const stubWsClient = { start() {}, stop() {} } as unknown as WolfxWsClient;
// 📌 実取得を止めるための既定スタブ (河川は全国巡回が走るため必須)
const quietFetchers = {
  p2pFetcher: async () => [],
  wolfxHttpFetcher: async () => null,
  typhoonFetcher: async () => [],
  riverFetcher: async () => ({ riverDrafts: [], damDrafts: [], fetchedSystems: 1, failures: [] }),
  heatFetcher: async () => null,
};
const LONG = 600000;
const quietIntervals = {
  p2pEewIntervalMs: LONG,
  p2pQuakeIntervalMs: LONG,
  p2pTsunamiIntervalMs: LONG,
  wolfxHttpIntervalMs: LONG,
  jmaWarningIntervalMs: LONG,
  jmaTyphoonIntervalMs: LONG,
  jmaXmlIntervalMs: LONG,
  riverIntervalMs: LONG,
  heatIntervalMs: LONG,
};

test("ハブ: 警報ポーリングがストアへ流れ、新規だけが配信される (2回目は配信なし)", async (t) => {
  const store = new EventStore();
  const events: A2sEvent[] = [];
  const drafts = parseWarningOffice(fixture("jma-warning-130000.json"), "130000");
  const hub = new Hub(store, {
    onEvent: (ev) => events.push(ev),
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => ({ drafts, fetchedOfficeCodes: ["130000"], failures: [] }),
    ...quietIntervals,
    jmaWarningIntervalMs: 15,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(70); // 初回 + 数回のポーリング
  hub.stop();
  assert.equal(store.counts().warning, 2);
  assert.equal(events.length, 2); // 新規は2件だけ (再ポーリングで再配信しない)
  assert.ok(events.every((e) => e.kind === "warning"));
  const health = hub.status();
  assert.ok(health.jmaWarning.lastSuccessAt);
  assert.ok(health.jmaWarning.lastEventAt);
  assert.ok(health.jmaTyphoon);
});

test("ハブ: 警報の全官署失敗では差分を適用せず、前回状態を保持する", async (t) => {
  const store = new EventStore();
  const drafts = parseWarningOffice(fixture("jma-warning-130000.json"), "130000");
  let failAll = false;
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () =>
      failAll
        ? { drafts: [], fetchedOfficeCodes: [], failures: [{ officeCode: "130000", message: "down" }] }
        : { drafts, fetchedOfficeCodes: ["130000"], failures: [] },
    ...quietIntervals,
    jmaWarningIntervalMs: 15,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(30);
  assert.equal(store.counts().warning, 2);
  failAll = true;
  await sleep(50);
  hub.stop();
  assert.equal(store.counts().warning, 2); // 全解除に見せない
  assert.ok(hub.status().jmaWarning.lastError);
});

test("ハブ: P2P の取得失敗は健康状態に記録され、保持状態は変わらない", async (t) => {
  const store = new EventStore();
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    p2pFetcher: async () => {
      throw new Error("network down");
    },
    ...quietIntervals,
    p2pQuakeIntervalMs: 15,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(50);
  hub.stop();
  const health = hub.status();
  assert.equal(health.p2p551.lastError, "network down");
  assert.ok(health.p2p551.lastErrorAt);
  assert.equal(health.p2p551.lastSuccessAt, null);
  assert.equal(store.counts().total, 0);
});

test("ハブ: WS 接続中は Wolfx HTTP フォールバックが止まり、切断で再開する", async (t) => {
  const store = new EventStore();
  const sockets: FakeSocket[] = [];
  let httpCalls = 0;
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...quietFetchers,
    wolfxHttpFetcher: async () => {
      httpCalls += 1;
      return null;
    },
    warningFetcher: async () => emptyWarning,
    ...quietIntervals,
    wolfxHttpIntervalMs: 10,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(45);
  assert.ok(httpCalls >= 2, "WS 未接続の間は HTTP フォールバックが動く");
  assert.equal(sockets.length, 1);

  sockets[0].open(); // WS 接続 → フォールバック停止
  await sleep(10);
  const stoppedAt = httpCalls;
  await sleep(45);
  assert.equal(httpCalls, stoppedAt, "WS 接続中は HTTP を叩かない");
  assert.equal(hub.status().wolfxWs.connected, true);

  sockets[0].close(); // 切断 → フォールバック再開
  await sleep(45);
  hub.stop();
  assert.ok(httpCalls > stoppedAt, "WS 切断後は HTTP フォールバックが再開する");
});

test("ハブ: 551 は1ページ目が満杯のときだけ offset で2ページ目まで広げる (L6)", async (t) => {
  const store = new EventStore({ maxAgeHours: 24 * 365 });
  const calls: { code: number; offset: number }[] = [];
  const { parseQuakes } = await import("../src/convert/p2p.js");
  const one = parseQuakes(fixture("p2p-551.json"))[0];
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    p2pFetcher: async (code, _limit, offset = 0) => {
      calls.push({ code, offset });
      if (code === 551 && offset === 0) return Array.from({ length: 20 }, () => one);
      return [];
    },
    warningFetcher: async () => emptyWarning,
    ...quietIntervals,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(30);
  hub.stop();
  assert.deepEqual(
    calls.filter((c) => c.code === 551).map((c) => c.offset),
    [0, 20],
  );
  assert.deepEqual(
    calls.filter((c) => c.code === 556).map((c) => c.offset),
    [0],
  );
});

test("ハブ: JMA XML の下書きがストアへ流れ、土砂はスナップショットで適用される", async (t) => {
  // 📌 フィクスチャ電文は発表が過去のため、ストアの年齢ガードを広げて使う
  const store = new EventStore({ maxAgeHours: 24 * 365 });
  const events: A2sEvent[] = [];
  const { parseTornadoTelegram, parseSedimentTelegram } = await import("../src/convert/jma-xml.js");
  const tornado = parseTornadoTelegram(fixtureText("jma-xml-vphw50-tornado.xml"), "VPHW50");
  assert.ok(tornado);
  const sediment = parseSedimentTelegram(fixtureText("jma-xml-vxww50-sediment.xml"));
  assert.ok(sediment);
  const hub = new Hub(store, {
    onEvent: (ev) => events.push(ev),
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    jmaXmlFetcher: async () => ({
      drafts: [tornado],
      sedimentDrafts: sediment.drafts,
      sedimentPrefs: [sediment.prefName],
      fetchedEntries: 2,
      failures: [],
    }),
    ...quietIntervals,
    jmaXmlIntervalMs: 15,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(60);
  hub.stop();
  assert.equal(store.counts().tornado, 1);
  assert.equal(store.counts().sediment, sediment.drafts.length);
  assert.ok(events.some((e) => e.kind === "tornado"));
  const health = hub.status();
  assert.ok(health.jmaXmlExtra.lastSuccessAt);
  assert.ok(health.jmaXmlExtra.lastEventAt);
});

test("ハブ: 熱中症はファイルが無い間は状態を保持し、取得できたらスナップショットを適用する", async (t) => {
  const store = new EventStore();
  const events: A2sEvent[] = [];
  const { parseWbgtAlertCsv } = await import("../src/convert/wbgt.js");
  const drafts = parseWbgtAlertCsv(fixtureText("wbgt-alert-20260815-17.csv"));
  assert.ok(drafts.length > 0);
  let available = false;
  const hub = new Hub(store, {
    onEvent: (ev) => events.push(ev),
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    heatFetcher: async () => (available ? drafts : null),
    ...quietIntervals,
    heatIntervalMs: 15,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(45);
  // 📌 ファイルが無い間はエラーにも解除にもしない
  assert.equal(store.counts().heat, 0);
  assert.equal(hub.status().heat.lastError, null);
  assert.equal(hub.status().heat.lastSuccessAt, null);
  available = true;
  await sleep(45);
  hub.stop();
  assert.equal(store.counts().heat, drafts.length);
  assert.ok(events.some((e) => e.kind === "heat"));
  assert.ok(hub.status().heat.lastSuccessAt);
});

test("ハブ: 河川は間隔0で無効 (取得自体が走らない)", async (t) => {
  const store = new EventStore();
  let riverCalls = 0;
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    riverFetcher: async () => {
      riverCalls += 1;
      return { riverDrafts: [], damDrafts: [], fetchedSystems: 1, failures: [] };
    },
    ...quietIntervals,
    riverIntervalMs: 0,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(50);
  hub.stop();
  assert.equal(riverCalls, 0);
});

test("ハブ: 河川・ダムは状態遷移のときだけ配信される (数値変化だけでは配信しない)", async (t) => {
  const store = new EventStore();
  const events: A2sEvent[] = [];
  const now = formatP2pTime(new Date());
  const riverDraft = (levelState: RiverDraft["levelState"], stateSeverity: number, value: number): RiverDraft => ({
    kind: "river",
    key: "river:level:0001",
    metric: "level",
    stationCode: "0001",
    stationName: "テスト観測所",
    riverName: "テスト川",
    systemName: "テスト水系",
    value,
    rain10m: null,
    observedAt: now,
    time: now,
    levelState,
    stateSeverity,
    thresholds: { standby: 1, caution: 2, refuge: 3, danger: 4, flood: 5 },
  });
  const damDraft = (discharging: boolean, outflow: number): DamDraft => ({
    kind: "dam",
    key: "dam:0001",
    damCode: "0001",
    name: "テストダム",
    riverName: "テスト川",
    systemName: "テスト水系",
    storageLevel: 100,
    storageRate: 50,
    inflow: 10,
    outflow,
    discharging,
    observedAt: now,
    time: now,
  });
  let phase = 0;
  const hub = new Hub(store, {
    onEvent: (ev) => events.push(ev),
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    riverFetcher: async () => {
      phase += 1;
      if (phase === 1) {
        // 📌 初回: 平常の河川と放流していないダム → どちらも配信しない
        return { riverDrafts: [riverDraft("平常", 0, 0.5)], damDrafts: [damDraft(false, 0)], fetchedSystems: 1, failures: [] };
      }
      if (phase === 2) {
        // 📌 数値だけ変化 (状態は同じ) → 配信しない
        return { riverDrafts: [riverDraft("平常", 0, 0.6)], damDrafts: [damDraft(false, 0)], fetchedSystems: 1, failures: [] };
      }
      // 📌 状態遷移: 氾濫注意へ上昇 + 放流開始 → どちらも配信する
      return { riverDrafts: [riverDraft("氾濫注意水位超過", 2, 2.5)], damDrafts: [damDraft(true, 5)], fetchedSystems: 1, failures: [] };
    },
    ...quietIntervals,
    riverIntervalMs: 20,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(110);
  hub.stop();
  assert.equal(store.counts().river, 1);
  assert.equal(store.counts().dam, 1);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["dam", "river"]);
});

test("ハブ: DMDSS の EEW 電文がストアへ流れ、健康状態に接続が載る", async (t) => {
  const store = new EventStore({ maxAgeHours: 24 * 365 });
  const events: A2sEvent[] = [];
  const sockets: FakeSocket[] = [];
  const hub = new Hub(store, {
    onEvent: (ev) => events.push(ev),
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    dmdssApiKey: "test-api-key",
    dmdssClassifications: ["eew.forecast"],
    dmdssStartSocket: async () => ({ url: "wss://example.invalid/socket" }),
    dmdssSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...quietIntervals,
  });
  t.after(() => hub.stop());
  hub.start();
  await sleep(20); // Socket Start (非同期) の完了待ち
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.equal(hub.status().dmdssWs.connected, true);
  const xml = fixtureText("dmdss-vxse45-eew.xml");
  const body = gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
  sockets[0].message(
    JSON.stringify({
      type: "data",
      classification: "eew.forecast",
      head: { type: "VXSE45", test: false },
      format: "xml",
      compression: "gzip",
      encoding: "base64",
      body,
    }),
  );
  await sleep(20);
  hub.stop();
  assert.equal(store.counts().eew, 1);
  assert.ok(events.some((e) => e.kind === "eew" && e.source === "dmdss"));
  assert.ok(hub.status().dmdssWs.lastEventAt);
});

test("ハブ: 健康状態が /v1/status の sources に載る", async (t) => {
  const store = new EventStore();
  const hub = new Hub(store, {
    onEvent: () => {},
    wolfxWsClient: stubWsClient,
    ...quietFetchers,
    warningFetcher: async () => emptyWarning,
    ...quietIntervals,
    jmaWarningIntervalMs: 15,
  });
  t.after(() => hub.stop());
  const a2s = createA2sServer({
    store,
    version: "0.1.0",
    statusProvider: () => hub.status(),
  });
  t.after(() => a2s.close());
  await new Promise<void>((resolve) => a2s.server.listen(0, "127.0.0.1", resolve));
  const port = (a2s.server.address() as AddressInfo).port;
  hub.start();
  await sleep(40);
  const res = await fetch(`http://127.0.0.1:${port}/v1/status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sources: Record<string, { lastSuccessAt: string | null }> };
  assert.ok(body.sources.jmaWarning);
  assert.ok(body.sources.jmaWarning.lastSuccessAt);
  assert.ok(body.sources.p2p551);
  assert.ok(body.sources.dmdssWs);
  hub.stop();
  await a2s.close();
});
