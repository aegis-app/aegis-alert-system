// ==========================================
// 🧪 テスト: 公開リスナー (認証・経路制限・レート制限・公開 EEW ゲート)
// ==========================================
// 📌 公開リスナーは中継経由で外部へ出る面のため、owner 拒否・無認証の
// 不在・読み取り系以外の秘匿・EEW の二条件ゲートを実 HTTP で検証する。
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { createA2sServer, createPublicA2sServer, type A2sServer } from "../src/server.js";
import { EventStore } from "../src/store.js";
import { formatP2pTime } from "../src/util.js";
import type { A2sEvent, EewDraft, QuakeDraft } from "../src/types.js";

const OWNER = "owner-secret";
const CLIENTS = new Map([
  ["bosai-web", "bosai-secret"],
  ["other", "other-secret"],
]);

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

// 📡 公開リスナーを立てる
async function startPublic(deps: Partial<Parameters<typeof createPublicA2sServer>[0]> = {}): Promise<Started> {
  const store = deps.store ?? new EventStore();
  const a2s = createPublicA2sServer({
    store,
    token: OWNER,
    clientTokens: CLIENTS,
    version: "0.1.0-test",
    statusProvider: () => ({}),
    ...deps,
  });
  await new Promise<void>((resolve) => a2s.server.listen(0, "127.0.0.1", resolve));
  const port = (a2s.server.address() as AddressInfo).port;
  return { a2s, store, base: `http://127.0.0.1:${port}` };
}

const asBosai = { Authorization: `Bearer ${CLIENTS.get("bosai-web")!}` };
const asOther = { Authorization: `Bearer ${CLIENTS.get("other")!}` };
const asOwner = { Authorization: `Bearer ${OWNER}` };

// 📨 SSE を読み、marker が届くまで待つ
async function readSseUntil(url: string, headers: Record<string, string>, marker: string, ms = 3000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(marker)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

describe("public listener authentication", () => {
  test("client tokens pass, the owner token is rejected, no token is 401", async (t) => {
    const { a2s, base } = await startPublic();
    t.after(() => a2s.close());
    assert.equal((await fetch(`${base}/v1/status`, { headers: asBosai })).status, 200);
    assert.equal((await fetch(`${base}/v1/status`, { headers: asOwner })).status, 401);
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  });

  test("with no client tokens configured, everything is rejected (never anonymous)", async (t) => {
    const { a2s, base } = await startPublic({ clientTokens: new Map(), token: undefined });
    t.after(() => a2s.close());
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
    assert.equal((await fetch(`${base}/v1/events`)).status, 401);
  });

  test("GET /health is the only unauthenticated endpoint", async (t) => {
    const { a2s, base } = await startPublic();
    t.after(() => a2s.close());
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Record<string, unknown>).ok, true);
  });
});

describe("public listener path restrictions", () => {
  test("non-read paths are hidden as 404, wrong methods on read paths are 405", async (t) => {
    const { a2s, base } = await startPublic();
    t.after(() => a2s.close());
    // 📌 公開ステータスは通常リスナーだけのもの。公開側では存在自体を見せない
    assert.equal((await fetch(`${base}/v1/status/public`, { headers: asBosai })).status, 404);
    assert.equal((await fetch(`${base}/v1/admin`, { headers: asBosai })).status, 404);
    assert.equal((await fetch(`${base}/v1/events`, { method: "POST", headers: asBosai })).status, 405);
    // 📌 経路制限がメソッド制限より先に効くため、秘匿パスへの POST も 404
    assert.equal((await fetch(`${base}/v1/status/public`, { method: "POST", headers: asBosai })).status, 404);
    // 📌 マスター系は読み取り系として公開側でも使える
    assert.equal((await fetch(`${base}/v1/master`, { headers: asBosai })).status, 404); // master 未指定のため
  });
});

describe("public listener rate limit", () => {
  test("the limit is per token and answers 429 with Retry-After", async (t) => {
    const { a2s, base } = await startPublic({ rateLimitPerMinute: 3 });
    t.after(() => a2s.close());
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${base}/v1/status`, { headers: asBosai })).status, 200);
    }
    const limited = await fetch(`${base}/v1/status`, { headers: asBosai });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // 📌 別トークンは別枠
    assert.equal((await fetch(`${base}/v1/status`, { headers: asOther })).status, 200);
  });
});

describe("public EEW gate", () => {
  test("without DMDSS, EEW reaches nobody on the public listener", async (t) => {
    const { a2s, store, base } = await startPublic({
      publicEewClients: new Set(["bosai-web"]),
      dmdssConfigured: false,
    });
    t.after(() => a2s.close());
    store.ingest(quakeDraft(), "p2p");
    store.ingest(eewDraft(), "dmdss");

    const events = (await (await fetch(`${base}/v1/events`, { headers: asBosai })).json()) as { events: A2sEvent[] };
    assert.deepEqual(
      events.events.map((e) => e.kind),
      ["quake"],
    );
    const eewOnly = (await (await fetch(`${base}/v1/events?kind=eew`, { headers: asBosai })).json()) as {
      events: A2sEvent[];
    };
    assert.equal(eewOnly.events.length, 0);
    const status = (await (await fetch(`${base}/v1/status`, { headers: asBosai })).json()) as Record<string, any>;
    assert.equal(status.eewDelivery, false);
  });

  test("with DMDSS and an allowlisted name, EEW is delivered to that client only", async (t) => {
    const { a2s, store, base } = await startPublic({
      publicEewClients: new Set(["bosai-web"]),
      dmdssConfigured: true,
    });
    t.after(() => a2s.close());
    store.ingest(eewDraft(), "dmdss");

    const allowed = (await (await fetch(`${base}/v1/events`, { headers: asBosai })).json()) as { events: A2sEvent[] };
    assert.equal(allowed.events.length, 1);
    const denied = (await (await fetch(`${base}/v1/events`, { headers: asOther })).json()) as { events: A2sEvent[] };
    assert.equal(denied.events.length, 0);
    const statusAllowed = (await (await fetch(`${base}/v1/status`, { headers: asBosai })).json()) as Record<string, any>;
    assert.equal(statusAllowed.eewDelivery, true);
    const statusDenied = (await (await fetch(`${base}/v1/status`, { headers: asOther })).json()) as Record<string, any>;
    assert.equal(statusDenied.eewDelivery, false);
  });

  test("the gate applies to SSE replay and live pushes per connection", async (t) => {
    const { a2s, store, base } = await startPublic({
      publicEewClients: new Set(["bosai-web"]),
      dmdssConfigured: true,
    });
    t.after(() => a2s.close());
    store.ingest(eewDraft(), "dmdss");

    // 📌 再生: 許可クライアントには eew が再生され、非許可には届かない
    const replayAllowed = await readSseUntil(`${base}/v1/stream`, asBosai, "event: ready");
    assert.ok(replayAllowed.includes("event: eew"));
    const replayDenied = await readSseUntil(`${base}/v1/stream`, asOther, "event: ready");
    assert.ok(!replayDenied.includes("event: eew"));
  });

  test("the owner listener has no EEW gate", async (t) => {
    const store = new EventStore();
    const a2s = createA2sServer({
      store,
      token: OWNER,
      clientTokens: CLIENTS,
      publicEewClients: new Set(),
      dmdssConfigured: false,
      version: "0.1.0-test",
      statusProvider: () => ({}),
    });
    t.after(() => a2s.close());
    await new Promise<void>((resolve) => a2s.server.listen(0, "127.0.0.1", resolve));
    const port = (a2s.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    store.ingest(eewDraft(), "dmdss");
    const events = (await (await fetch(`${base}/v1/events`, { headers: asOther })).json()) as { events: A2sEvent[] };
    assert.equal(events.events.length, 1);
    const status = (await (await fetch(`${base}/v1/status`, { headers: asOther })).json()) as Record<string, any>;
    assert.equal(status.eewDelivery, true);
  });
});

describe("shared SSE hub", () => {
  test("a broadcast on the owner listener reaches public listener connections", async (t) => {
    const store = new EventStore();
    const owner = createA2sServer({
      store,
      token: OWNER,
      clientTokens: CLIENTS,
      version: "0.1.0-test",
      statusProvider: () => ({}),
    });
    const pub = await startPublic({ store, sseHub: owner.sseHub });
    t.after(async () => {
      await pub.a2s.close();
      await owner.close();
    });
    // 📌 公開側の接続を張り、ready まで読んでから broadcast する
    const ctrl = new AbortController();
    const res = await fetch(`${pub.base}/v1/stream`, { headers: asBosai, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (marker: string): Promise<void> => {
      while (!text.includes(marker)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil("event: ready");
    const ev = store.ingest(quakeDraft(), "p2p").event;
    owner.broadcast(ev);
    await readUntil("event: quake");
    assert.ok(text.includes("event: quake"));
    ctrl.abort();
  });
});
