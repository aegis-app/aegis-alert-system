// ==========================================
// 🧪 テスト: 配信サーバー (通常リスナー: REST / SSE / 認証 / CORS)
// ==========================================
// 📌 ローカルでサーバーを立て、実際の HTTP で基本動作を検証する。
// 下書きの時刻は実時刻からの相対値で生成する (固定した過去日時の
// フィクスチャは保持期間を過ぎると壊れるため)。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { AccessLogger } from "../src/access-log.js";
import { MasterDataService } from "../src/master.js";
import { createA2sServer, SseHub, type A2sServer, type SseSink } from "../src/server.js";
import { EventStore } from "../src/store.js";
import { formatP2pTime } from "../src/util.js";
import type { A2sEvent, EewDraft, QuakeDraft } from "../src/types.js";

// 📊 テスト用の経路健康状態 (詳細つき)
function healthFixture(): Record<string, unknown> {
  return {
    p2p551: {
      lastPollAt: "2026-11-28T00:00:10.000Z",
      lastSuccessAt: "2026-11-28T00:00:10.000Z",
      lastEventAt: "2026-11-28T00:00:09.000Z",
      lastError: "一時的な取得失敗",
      lastErrorAt: "2026-11-27T23:00:00.000Z",
    },
    wolfxWs: { connected: false, lastSuccessAt: null, lastEventAt: null, lastError: null, lastErrorAt: null },
    fresh: { lastPollAt: null, lastSuccessAt: null, lastEventAt: null, lastError: null, lastErrorAt: null },
  };
}

// 🌍 地震の下書き (時刻は実時刻の1分前)
function quakeDraft(overrides: Partial<QuakeDraft> = {}): QuakeDraft {
  const time = formatP2pTime(new Date(Date.now() - 60_000));
  return {
    kind: "quake",
    key: `551:${time}|@35.7,139.7`,
    telegramId: "20261128115900",
    time,
    announcedTime: time,
    originTime: null,
    hypocenter: "テスト震源",
    magnitude: 4.5,
    depthKm: 10,
    maxScale: 40,
    tsunamiKind: "None",
    tsunamiText: null,
    foreign: false,
    issueType: "DetailScale",
    issueCorrect: "None",
    lat: 35.7,
    lon: 139.7,
    topPoint: null,
    topPointIsArea: false,
    prefScales: [],
    points: [],
    ...overrides,
  };
}

// 🚨 EEW の下書き
function eewDraft(overrides: Partial<EewDraft> = {}): EewDraft {
  return {
    kind: "eew",
    key: "eew-id:20261128120000",
    baseKey: "eew-id:20261128120000",
    time: formatP2pTime(new Date(Date.now() - 60_000)),
    originTime: formatP2pTime(new Date(Date.now() - 120_000)),
    cancel: false,
    isWarn: false,
    isFinal: false,
    serial: 1,
    eventId: "20261128120000",
    isAssumption: false,
    hypocenter: "テスト震源",
    estScale: 40,
    estMagnitude: 5.0,
    prefs: [],
    lat: 35.7,
    lon: 139.7,
    depthKm: 10,
    areaArrivals: [],
    areaScales: [],
    ...overrides,
  };
}

interface Started {
  a2s: A2sServer;
  store: EventStore;
  base: string;
}

// 🔑 Bearer ヘッダを組み立てる
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

// 📡 テスト用サーバーを立てる
async function startServer(deps: Partial<Parameters<typeof createA2sServer>[0]> = {}): Promise<Started> {
  const store = deps.store ?? new EventStore();
  const a2s = createA2sServer({
    store,
    version: "0.1.0-test",
    statusProvider: healthFixture,
    ...deps,
  });
  await new Promise<void>((resolve) => a2s.server.listen(0, "127.0.0.1", resolve));
  const port = (a2s.server.address() as AddressInfo).port;
  return { a2s, store, base: `http://127.0.0.1:${port}` };
}

// 📨 SSE クライアント (受信テキストの蓄積と待機)
interface SseTestClient {
  text: () => string;
  waitFor: (marker: string, ms?: number) => Promise<string>;
  close: () => void;
}

async function connectSse(url: string, headers: Record<string, string> = {}): Promise<SseTestClient> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  let text = "";
  const waiters: { marker: string; resolve: (text: string) => void }[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (text.includes(waiters[i].marker)) {
            waiters[i].resolve(text);
            waiters.splice(i, 1);
          }
        }
      }
    } catch {
      // ⚠️ 切断 (テスト終了時の abort) は正常
    }
  })();
  return {
    text: () => text,
    waitFor: (marker, ms = 3000) => {
      if (text.includes(marker)) return Promise.resolve(text);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${JSON.stringify(marker)}; got: ${text}`)),
          ms,
        );
        waiters.push({
          marker,
          resolve: (t2) => {
            clearTimeout(timer);
            resolve(t2);
          },
        });
      });
    },
    close: () => ctrl.abort(),
  };
}

describe("health and status", () => {
  test("GET /health answers without authentication", async (t) => {
    const { a2s, base } = await startServer({ token: "owner-secret" });
    t.after(() => a2s.close());
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, "aegis-alert-system");
    const post = await fetch(`${base}/health`, { method: "POST" });
    assert.equal(post.status, 405);
  });

  test("GET /v1/status returns counts and source health", async (t) => {
    const { a2s, store, base } = await startServer();
    t.after(() => a2s.close());
    store.ingest(quakeDraft(), "p2p");
    const res = await fetch(`${base}/v1/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.service, "aegis-alert-system");
    assert.equal(body.auth, "none");
    assert.equal(body.eewDelivery, true);
    assert.equal(body.counts.quake, 1);
    assert.equal(body.sources.p2p551.lastError, "一時的な取得失敗");
  });

  test("GET /v1/status/public is coarse: no error details, ok/ng/idle only", async (t) => {
    const { a2s, base } = await startServer({ token: "owner-secret" });
    t.after(() => a2s.close());
    // 📌 無認証で引ける (bosai の表示用)
    const res = await fetch(`${base}/v1/status/public`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.sources.p2p551.status, "ok");
    assert.equal(body.sources.p2p551.lastSuccessAt, "2026-11-28T00:00:10.000Z");
    assert.equal(body.sources.wolfxWs.status, "ng");
    assert.equal(body.sources.fresh.status, "idle");
    // 📌 エラーの文面やポーリング時刻は構造的に含まれない
    assert.ok(!("lastError" in body.sources.p2p551));
    assert.ok(!("lastErrorAt" in body.sources.p2p551));
    assert.ok(!("lastPollAt" in body.sources.p2p551));
    const post = await fetch(`${base}/v1/status/public`, { method: "POST" });
    assert.equal(post.status, 405);
  });
});

describe("authentication", () => {
  test("owner and client tokens pass; missing or wrong tokens are 401", async (t) => {
    const clientTokens = new Map([["bosai-web", "client-secret"]]);
    const { a2s, base } = await startServer({ token: "owner-secret", clientTokens });
    t.after(() => a2s.close());
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
    const wrong = await fetch(`${base}/v1/status`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "unauthorized" });
    const owner = await fetch(`${base}/v1/status`, { headers: bearer("owner-secret") });
    assert.equal(owner.status, 200);
    assert.equal(((await owner.json()) as Record<string, any>).auth, "token");
    const client = await fetch(`${base}/v1/status`, { headers: bearer("client-secret") });
    assert.equal(client.status, 200);
  });

  test("SSE accepts ?token=, including when the header token is wrong", async (t) => {
    const { a2s, base } = await startServer({ token: "owner-secret" });
    t.after(() => a2s.close());
    const byQuery = await connectSse(`${base}/v1/stream?token=${"owner-secret"}`);
    await byQuery.waitFor("event: ready");
    byQuery.close();
    const mixed = await connectSse(`${base}/v1/stream?token=${"owner-secret"}`, {
      Authorization: "Bearer wrong",
    });
    await mixed.waitFor("event: ready");
    mixed.close();
    const denied = await fetch(`${base}/v1/stream`);
    assert.equal(denied.status, 401);
  });
});

describe("events endpoint", () => {
  test("filters by kind, source, since and limit; bad params are 400", async (t) => {
    const { a2s, store, base } = await startServer();
    t.after(() => a2s.close());
    const quake = store.ingest(quakeDraft(), "p2p").event;
    store.ingest(eewDraft(), "dmdss");

    const all = (await (await fetch(`${base}/v1/events`)).json()) as { events: A2sEvent[] };
    assert.equal(all.events.length, 2);

    const quakes = (await (await fetch(`${base}/v1/events?kind=quake`)).json()) as { events: A2sEvent[] };
    assert.deepEqual(
      quakes.events.map((e) => e.kind),
      ["quake"],
    );

    const fromDmdss = (await (await fetch(`${base}/v1/events?source=dmdss`)).json()) as { events: A2sEvent[] };
    assert.deepEqual(
      fromDmdss.events.map((e) => e.kind),
      ["eew"],
    );

    // 📌 since は境界を含む (最後に見た updatedAt で欠落なく回収できる)
    const sinceBoundary = (await (
      await fetch(`${base}/v1/events?since=${Date.parse(quake.updatedAt)}`)
    ).json()) as { events: A2sEvent[] };
    assert.ok(sinceBoundary.events.some((e) => e.key === quake.key));
    const future = (await (await fetch(`${base}/v1/events?since=2999-01-01T00:00:00Z`)).json()) as {
      events: A2sEvent[];
    };
    assert.equal(future.events.length, 0);

    const limited = (await (await fetch(`${base}/v1/events?limit=1`)).json()) as { events: A2sEvent[] };
    assert.equal(limited.events.length, 1);

    assert.equal((await fetch(`${base}/v1/events?kind=bogus`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/v1/events?kind=bogus`)).json(), { error: "invalid_kind" });
    assert.equal((await fetch(`${base}/v1/events?source=bogus`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/v1/events?source=bogus`)).json(), { error: "invalid_source" });
    assert.equal((await fetch(`${base}/v1/events?since=not-a-date`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/v1/events?since=not-a-date`)).json(), { error: "invalid_since" });
  });

  test("unknown paths are 404 and non-GET methods are 405", async (t) => {
    const { a2s, base } = await startServer();
    t.after(() => a2s.close());
    const nf = await fetch(`${base}/v1/nope`);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: "not_found" });
    const post = await fetch(`${base}/v1/events`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.deepEqual(await post.json(), { error: "method_not_allowed" });
  });
});

describe("SSE stream", () => {
  test("replays stored events oldest first, then ready, then live pushes", async (t) => {
    const { a2s, store, base } = await startServer();
    t.after(() => a2s.close());
    store.ingest(quakeDraft({ hypocenter: "震源A" }), "p2p");
    await new Promise((r) => setTimeout(r, 5));
    const second = quakeDraft({
      hypocenter: "震源B",
      time: formatP2pTime(new Date(Date.now() - 30_000)),
      announcedTime: formatP2pTime(new Date(Date.now() - 30_000)),
      key: `551:${formatP2pTime(new Date(Date.now() - 30_000))}|@36.7,139.7`,
      lat: 36.7,
    });
    store.ingest(second, "p2p");

    const client = await connectSse(`${base}/v1/stream`);
    const replayed = await client.waitFor("event: ready");
    const idxA = replayed.indexOf("震源A");
    const idxB = replayed.indexOf("震源B");
    assert.ok(idxA >= 0 && idxB > idxA, "replay must be oldest first");

    // 📌 接続後の新規イベントは broadcast で届く
    const live = store.ingest(eewDraft(), "p2p").event;
    a2s.broadcast(live);
    const pushed = await client.waitFor("event: eew");
    assert.ok(pushed.includes("event: eew"));
    client.close();
  });

  test("since= limits the replay to events updated at or after it", async (t) => {
    const { a2s, store, base } = await startServer();
    t.after(() => a2s.close());
    const first = store.ingest(quakeDraft({ hypocenter: "震源A" }), "p2p").event;
    await new Promise((r) => setTimeout(r, 5));
    const secondDraft = quakeDraft({
      hypocenter: "震源B",
      time: formatP2pTime(new Date(Date.now() - 30_000)),
      announcedTime: formatP2pTime(new Date(Date.now() - 30_000)),
      key: `551:${formatP2pTime(new Date(Date.now() - 30_000))}|@36.7,139.7`,
      lat: 36.7,
    });
    const second = store.ingest(secondDraft, "p2p").event;

    const sinceFirst = await connectSse(`${base}/v1/stream?since=${Date.parse(first.updatedAt)}`);
    const text1 = await sinceFirst.waitFor("event: ready");
    assert.ok(text1.includes("震源A") && text1.includes("震源B"));
    sinceFirst.close();

    const afterAll = await connectSse(`${base}/v1/stream?since=${Date.parse(second.updatedAt) + 1}`);
    const text2 = await afterAll.waitFor("event: ready");
    assert.ok(!text2.includes("event: quake"));
    afterAll.close();

    const bad = await fetch(`${base}/v1/stream?since=not-a-date`);
    assert.equal(bad.status, 400);
  });

  test("the hub sends heartbeat comment frames", async () => {
    const hub = new SseHub(40);
    const frames: string[] = [];
    const sink: SseSink = {
      writeFrame: (f) => frames.push(f),
      writeBurstFrame: (f) => frames.push(f),
      close: () => {},
      closed: false,
    };
    hub.add(sink);
    await new Promise((r) => setTimeout(r, 130));
    hub.close();
    assert.ok(frames.some((f) => f.startsWith(": ping ")));
  });
});

describe("master endpoints", () => {
  test("index, unavailable and unknown datasets follow the registry", async (t) => {
    const master = new MasterDataService();
    const { a2s, base } = await startServer({ master });
    t.after(() => a2s.close());

    const indexRes = await fetch(`${base}/v1/master`);
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get("cache-control"), "public, max-age=300");
    const index = (await indexRes.json()) as { datasets: { name: string; available: boolean }[] };
    assert.equal(index.datasets.length, 9);
    assert.ok(index.datasets.every((d) => !d.available));

    const unavailable = await fetch(`${base}/v1/master/stations`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "master_unavailable", dataset: "stations" });

    const unknown = await fetch(`${base}/v1/master/bogus`);
    assert.equal(unknown.status, 404);

    master.registerStatic("stations", { body: JSON.stringify({ stations: [] }), count: 0, generatedAt: "2026-11-22" });
    const served = await fetch(`${base}/v1/master/stations`);
    assert.equal(served.status, 200);
    assert.deepEqual(await served.json(), { stations: [] });
  });

  test("without a master service the master paths are 404", async (t) => {
    const { a2s, base } = await startServer();
    t.after(() => a2s.close());
    assert.equal((await fetch(`${base}/v1/master`)).status, 404);
    assert.equal((await fetch(`${base}/v1/master/stations`)).status, 404);
  });
});

describe("CORS", () => {
  test("only configured origins receive CORS headers and preflights", async (t) => {
    const { a2s, base } = await startServer();
    t.after(() => a2s.close());
    const allowed = await fetch(`${base}/v1/status`, { headers: { Origin: "https://bosai.vercel.app" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://bosai.vercel.app");
    const denied = await fetch(`${base}/v1/status`, { headers: { Origin: "https://evil.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${base}/v1/events`, {
      method: "OPTIONS",
      headers: { Origin: "https://bosai.vercel.app", "Access-Control-Request-Headers": "Authorization" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization");

    const badPreflight = await fetch(`${base}/v1/events`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(badPreflight.status, 405);
    assert.equal(badPreflight.headers.get("access-control-allow-origin"), null);
  });
});

describe("access log", () => {
  test("authenticated requests are logged by name, never by token value", async (t: TestContext) => {
    const dir = mkdtempSync(join(tmpdir(), "aas-access-"));
    const file = join(dir, "access.log");
    const accessLog = new AccessLogger(file);
    const { a2s, base } = await startServer({ token: "owner-secret", accessLog });
    t.after(() => a2s.close());
    const res = await fetch(`${base}/v1/status`, { headers: bearer("owner-secret") });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const content = readFileSync(file, "utf8");
    assert.match(content, / owner GET \/v1\/status 200\n$/);
    assert.ok(!content.includes("owner-secret"));
  });
});
