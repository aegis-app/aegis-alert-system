// ==========================================
// 🧪 テスト: イベントストア (同一視・保持ガード・復旧・永続化)
// ==========================================
// 📌 時刻に依存するテストは必ずモックタイマーで時計を固定する
// (apis は "Date" のみに限定し、setTimeout 等の実時間挙動は残す)。
// 実時刻と実電文フィクスチャの組み合わせは、フィクスチャが保持期間を
// 超えた瞬間に壊れる時限式になるため、ここでは下書きの時刻を固定した
// 時計からの相対値で生成する。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { EventStore } from "../src/store.js";
import { formatP2pTime } from "../src/util.js";
import type {
  EewDraft,
  EewEvent,
  QuakeDraft,
  RiverDraft,
  TyphoonDraft,
  WarningDraft,
  WarningEvent,
} from "../src/types.js";

// 🕐 テストの基準時刻 (固定)
const BASE_MS = Date.parse("2026-11-28T03:00:00.000Z");

// 🕐 時計を基準時刻に固定する
function pinClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: BASE_MS });
}

// 🕐 固定した時計を進める
function tick(t: TestContext, ms: number): void {
  t.mock.timers.tick(ms);
}

// 🕐 現在 (固定時計) から offsetMs ずらした P2P 表記
function p2pTime(offsetMs: number): string {
  return formatP2pTime(new Date(Date.now() + offsetMs));
}

// 🌍 地震の下書き (時刻は固定時計からの相対値)
function quakeDraft(overrides: Partial<QuakeDraft> = {}): QuakeDraft {
  const time = p2pTime(-60_000);
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
    time: p2pTime(-60_000),
    originTime: p2pTime(-120_000),
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

// ⚠️ 警報の下書き (reportDatetime は引数で決める)
function warningDraft(reportMs: number, overrides: Partial<WarningDraft> = {}): WarningDraft {
  const dt = new Date(reportMs).toISOString();
  return {
    kind: "warning",
    key: "warning:130000:13101",
    officeCode: "130000",
    prefName: "東京都",
    areaCode: "13101",
    areaName: "千代田区",
    reportDatetime: dt,
    headline: "テスト警報",
    warnings: [{ code: "14", name: "大雨警報", status: "発表", severity: 3 }],
    maxSeverity: 3,
    time: dt,
    released: false,
    ...overrides,
  };
}

// 🏞️ 河川観測値の下書き
function riverDraft(overrides: Partial<RiverDraft> = {}): RiverDraft {
  const time = p2pTime(-60_000);
  return {
    kind: "river",
    key: "river:level:0900100000000",
    metric: "level",
    stationCode: "0900100000000",
    stationName: "テスト観測所",
    riverName: "テスト川",
    systemName: "テスト水系",
    value: 1.23,
    rain10m: null,
    observedAt: time,
    time,
    levelState: "平常",
    stateSeverity: 0,
    thresholds: { standby: null, caution: null, refuge: null, danger: null, flood: null },
    ...overrides,
  };
}

describe("identity and change detection", () => {
  test("re-ingesting the same draft is 'none' and keeps the envelope", (t) => {
    pinClock(t);
    const store = new EventStore();
    const draft = quakeDraft();
    const first = store.ingest(draft, "p2p");
    assert.equal(first.change, "new");
    tick(t, 5000);
    const again = store.ingest(draft, "p2p");
    assert.equal(again.change, "none");
    assert.equal(store.counts().total, 1);
    // 📌 receivedAt / updatedAt は初回のまま (内容が変わっていないため)
    assert.equal(again.event.receivedAt, first.event.receivedAt);
    assert.equal(again.event.updatedAt, first.event.updatedAt);
  });

  test("a content change is 'updated' and advances updatedAt only", (t) => {
    pinClock(t);
    const store = new EventStore();
    const draft = quakeDraft();
    const first = store.ingest(draft, "p2p");
    tick(t, 60_000);
    const updated = store.ingest({ ...draft, magnitude: 5.1 }, "p2p");
    assert.equal(updated.change, "updated");
    assert.equal(updated.event.receivedAt, first.event.receivedAt);
    assert.ok(updated.event.updatedAt > first.event.updatedAt);
    assert.equal(store.counts().total, 1);
  });

  test("route confluence is recorded in sources without a change", (t) => {
    pinClock(t);
    const store = new EventStore();
    const draft = quakeDraft();
    store.ingest(draft, "p2p");
    const merged = store.ingest(draft, "dmdss");
    assert.equal(merged.change, "none");
    // 📌 合流は保存側のイベントに記録される (change "none" の戻り値は
    // 合流前のイベントのため、保存側で確認する)
    const stored = store.getEvent(draft.key);
    assert.deepEqual([...(stored?.sources ?? [])].sort(), ["dmdss", "p2p"]);
    // 📡 source 絞り込みは合流した全経路で引ける
    assert.equal(store.list({ source: "dmdss" }).length, 1);
    assert.equal(store.list({ source: "jma" }).length, 0);
  });

  test("counts are reported per kind with a total", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.ingest(quakeDraft(), "p2p");
    store.ingest(eewDraft(), "p2p");
    const counts = store.counts();
    assert.equal(counts.quake, 1);
    assert.equal(counts.eew, 1);
    assert.equal(counts.tsunami, 0);
    assert.equal(counts.total, 2);
  });
});

describe("72-hour retention guard", () => {
  test("a draft older than 72 hours is neither stored nor delivered", (t) => {
    pinClock(t);
    const store = new EventStore();
    const old = quakeDraft({
      time: p2pTime(-73 * 3600_000),
      announcedTime: p2pTime(-73 * 3600_000),
      key: `551:${p2pTime(-73 * 3600_000)}|@35.7,139.7`,
    });
    const r = store.ingest(old, "p2p");
    assert.equal(r.change, "none");
    assert.equal(store.counts().total, 0);
  });

  test("a draft just inside 72 hours is accepted, and exactly 72 hours is not dropped", (t) => {
    pinClock(t);
    const store = new EventStore();
    const inside = quakeDraft({
      time: p2pTime(-71 * 3600_000),
      announcedTime: p2pTime(-71 * 3600_000),
      key: `551:${p2pTime(-71 * 3600_000)}|@35.7,139.7`,
    });
    assert.equal(store.ingest(inside, "p2p").change, "new");
    const boundary = quakeDraft({
      time: p2pTime(-72 * 3600_000),
      announcedTime: p2pTime(-72 * 3600_000),
      key: `551:${p2pTime(-72 * 3600_000)}|@36.7,139.7`,
      lat: 36.7,
    });
    assert.equal(store.ingest(boundary, "p2p").change, "new");
    assert.equal(store.counts().quake, 2);
  });

  test("an aged re-ingest of a stored event returns 'none' with the stored event", (t) => {
    pinClock(t);
    const store = new EventStore();
    const draft = quakeDraft();
    store.ingest(draft, "p2p");
    tick(t, 73 * 3600_000);
    const r = store.ingest(draft, "p2p");
    assert.equal(r.change, "none");
    assert.equal(r.event.key, draft.key);
  });

  test("active-set kinds are exempt: old warnings survive apply and prune", (t) => {
    pinClock(t);
    const store = new EventStore();
    // 📌 30日前の発表でも、有効集合型はスナップショット適用で保持される
    const results = store.applyWarningSnapshot(
      [warningDraft(BASE_MS - 30 * 24 * 3600_000)],
      ["130000"],
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].change, "new");
    assert.equal(store.counts().warning, 1);
    // 📌 さらに10日進めて prune しても年齢では落ちない
    tick(t, 10 * 24 * 3600_000);
    store.prune();
    assert.equal(store.counts().warning, 1);
  });

  test("non-active kinds are pruned by age while warnings are kept", (t) => {
    pinClock(t);
    const store = new EventStore({ maxAgeHours: 1 });
    store.ingest(quakeDraft(), "p2p");
    store.applyWarningSnapshot([warningDraft(BASE_MS)], ["130000"]);
    tick(t, 2 * 3600_000);
    store.prune();
    assert.equal(store.counts().quake, 0);
    assert.equal(store.counts().warning, 1);
  });
});

describe("since recovery", () => {
  test("list with sinceMs is inclusive of the boundary and newest-first", (t) => {
    pinClock(t);
    const store = new EventStore();
    const aDraft = quakeDraft();
    const a = store.ingest(aDraft, "p2p").event;
    tick(t, 1000);
    const bDraft = quakeDraft({
      time: p2pTime(-30_000),
      announcedTime: p2pTime(-30_000),
      key: `551:${p2pTime(-30_000)}|@36.7,139.7`,
      lat: 36.7,
    });
    const b = store.ingest(bDraft, "p2p").event;
    tick(t, 1000);
    const a2 = store.ingest({ ...aDraft, magnitude: 5.5 }, "p2p").event;

    // 📌 切断したクライアントが最後に見た updatedAt (b) を since に渡すと、
    // b 自身 (境界) と、それ以降に更新された a が欠落なく回収できる
    const recovered = store.list({ sinceMs: Date.parse(b.updatedAt) });
    assert.deepEqual(
      recovered.map((e) => e.key),
      [a2.key, b.key],
    );
    assert.equal(store.list({ sinceMs: Date.parse(a2.updatedAt) }).length, 1);
    assert.equal(store.list({ sinceMs: Date.parse(a2.updatedAt) + 1 }).length, 0);
    assert.equal(a.key, a2.key);
  });

  test("list filters by kind and limit", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.ingest(quakeDraft(), "p2p");
    store.ingest(eewDraft(), "p2p");
    assert.equal(store.list({ kind: "eew" }).length, 1);
    assert.equal(store.list({ kind: "tsunami" }).length, 0);
    assert.equal(store.list({ limit: 1 }).length, 1);
  });
});

describe("EEW merge rules", () => {
  test("a warning report upgrades a forecast for the same event", (t) => {
    pinClock(t);
    const store = new EventStore();
    const r1 = store.ingest(eewDraft(), "wolfx-ws");
    assert.equal(r1.change, "new");
    assert.equal((r1.event as EewEvent).isWarn, false);
    tick(t, 1000);
    const r2 = store.ingest(eewDraft({ isWarn: true, time: p2pTime(-30_000) }), "p2p");
    assert.equal(r2.change, "updated");
    const ev = r2.event as EewEvent;
    assert.equal(ev.isWarn, true);
    assert.deepEqual([...ev.sources].sort(), ["p2p", "wolfx-ws"]);
    assert.equal(store.counts().eew, 1);
  });

  test("an older forecast never downgrades a warning", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.ingest(eewDraft({ isWarn: true }), "p2p");
    const r = store.ingest(eewDraft({ isWarn: false, time: p2pTime(-90_000) }), "wolfx-http");
    assert.equal(r.change, "none");
    assert.equal((r.event as EewEvent).isWarn, true);
  });

  test("cancellation is terminal and sticky", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.ingest(eewDraft(), "p2p");
    const cancel = store.ingest(
      eewDraft({ cancel: true, serial: 2, key: "eew-id:20261128120000-cancel", time: p2pTime(-30_000) }),
      "p2p",
    );
    assert.equal(cancel.change, "updated");
    assert.equal((cancel.event as EewEvent).cancel, true);
    assert.equal(store.counts().eew, 1);
    // 📌 取消後に同じ第1報が再配信されても取消は覆らない
    const again = store.ingest(eewDraft(), "p2p");
    assert.equal(again.change, "none");
    assert.equal((again.event as EewEvent).cancel, true);
  });

  test("isFinal sticks regardless of which report wins", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.ingest(eewDraft({ isFinal: true }), "wolfx-ws");
    const upgraded = store.ingest(
      eewDraft({ isWarn: true, isFinal: false, serial: 5, time: p2pTime(-30_000) }),
      "p2p",
    );
    assert.equal(upgraded.change, "updated");
    assert.equal((upgraded.event as EewEvent).isWarn, true);
    assert.equal((upgraded.event as EewEvent).isFinal, true);
  });
});

describe("quake key migration", () => {
  test("a prompt report keyed by name migrates to the coordinate key", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const prompt = quakeDraft({
      key: `551:${time}|テスト震源`,
      lat: null,
      lon: null,
      issueType: "ScalePrompt",
    });
    store.ingest(prompt, "p2p");
    const detail = quakeDraft({ time, announcedTime: time });
    const r = store.ingest(detail, "p2p");
    assert.equal(r.change, "updated");
    assert.equal(store.counts().quake, 1);
    assert.equal(r.event.key, detail.key);
    assert.ok(store.getEvent(detail.key));
  });
});

describe("quake re-delivery stability", () => {
  // 📌 2026-11-28 の事象の再現形: 保存済みイベントは震度速報+詳細報の
  // 統合で観測点 (地域代表を含む) を蓄積している。後続のポーリングで
  // 履歴窓の構成が変わり、詳細報だけから作り直された下書きが届いても、
  // 実質的な変化がないため更新扱いにしてはいけない
  test("a subset re-delivery (detail report only) is 'none' and keeps accumulated points", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const announced = p2pTime(-55_000);
    const stationPoints: QuakeDraft["points"] = [
      { pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false },
      { pref: "熊本県", name: "水俣市牧ノ内", scale: 20, isArea: false },
    ];
    const full = quakeDraft({
      key,
      time,
      announcedTime: announced,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: [...stationPoints, { pref: "熊本県", name: "熊本県天草・芦北", scale: 30, isArea: true }],
    });
    const first = store.ingest(full, "p2p");
    assert.equal(first.change, "new");
    tick(t, 30_000);
    // 📌 速報が窓から脱落し、詳細報だけから作り直された下書き
    const subset = quakeDraft({
      key,
      time,
      announcedTime: announced,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: stationPoints,
    });
    const again = store.ingest(subset, "p2p");
    assert.equal(again.change, "none");
    assert.equal(again.event.updatedAt, first.event.updatedAt);
    // 📌 蓄積した地域代表の観測点も失われない
    assert.equal((again.event as { points: unknown[] }).points.length, 3);
    assert.equal(store.getEvent(key)?.updatedAt, first.event.updatedAt);
  });

  test("a reordered re-delivery from another route is 'none' (route still recorded)", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const points: QuakeDraft["points"] = [
      { pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false },
      { pref: "鹿児島県", name: "出水市高尾野", scale: 20, isArea: false },
      { pref: "宮崎県", name: "延岡市北川町", scale: 20, isArea: false },
    ];
    const draft = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [
        { pref: "熊本県", scale: 30 },
        { pref: "鹿児島県", scale: 20 },
        { pref: "宮崎県", scale: 20 },
      ],
      points,
    });
    const first = store.ingest(draft, "p2p");
    tick(t, 30_000);
    // 📌 DMDSS 経路は観測点をソートして作るため、同じ内容でも並びが違う
    const reordered = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [
        { pref: "熊本県", scale: 30 },
        { pref: "宮崎県", scale: 20 },
        { pref: "鹿児島県", scale: 20 },
      ],
      points: [...points].reverse(),
    });
    const again = store.ingest(reordered, "dmdss");
    assert.equal(again.change, "none");
    assert.equal(again.event.updatedAt, first.event.updatedAt);
    assert.deepEqual([...(store.getEvent(key)?.sources ?? [])].sort(), ["dmdss", "p2p"]);
  });

  test("a late lower-stage report never rolls back confirmed values", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const detail = quakeDraft({
      key,
      time,
      announcedTime: p2pTime(-55_000),
      magnitude: 4.0,
      depthKm: 0,
      maxScale: 30,
      tsunamiKind: "None",
    });
    store.ingest(detail, "p2p");
    tick(t, 30_000);
    // 📌 遅れて届いた震度速報の下書き (値が未確定で、観測点は既存の部分集合)
    const prompt = quakeDraft({
      key,
      time,
      announcedTime: time,
      telegramId: "prompt-id",
      issueType: "ScalePrompt",
      magnitude: null,
      depthKm: null,
      lat: null,
      lon: null,
      maxScale: 30,
      tsunamiKind: "Checking",
    });
    const r = store.ingest(prompt, "p2p");
    assert.equal(r.change, "none");
    const stored = store.getEvent(key) as { magnitude: number | null; issueType: string; tsunamiKind: string };
    assert.equal(stored.magnitude, 4.0);
    assert.equal(stored.issueType, "DetailScale");
    assert.equal(stored.tsunamiKind, "None");
  });

  test("a re-delivery adds new observation points as 'updated'", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const base = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: [{ pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false }],
    });
    const first = store.ingest(base, "p2p");
    tick(t, 30_000);
    const grown = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [
        { pref: "熊本県", scale: 30 },
        { pref: "鹿児島県", scale: 20 },
      ],
      points: [
        { pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false },
        { pref: "鹿児島県", name: "出水市高尾野", scale: 20, isArea: false },
      ],
    });
    const r = store.ingest(grown, "p2p");
    assert.equal(r.change, "updated");
    assert.ok(r.event.updatedAt > first.event.updatedAt);
    assert.equal((r.event as { points: unknown[] }).points.length, 2);
  });

  test("a scale increase on an existing point is 'updated'", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const base = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 20,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 20 }],
      points: [{ pref: "熊本県", name: "芦北町芦北", scale: 20, isArea: false }],
    });
    const first = store.ingest(base, "p2p");
    tick(t, 30_000);
    const raised = quakeDraft({
      key,
      time,
      announcedTime: time,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: [{ pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false }],
    });
    const r = store.ingest(raised, "p2p");
    assert.equal(r.change, "updated");
    assert.ok(r.event.updatedAt > first.event.updatedAt);
    assert.equal((r.event as { maxScale: number }).maxScale, 30);
  });

  test("stage progression replaces the primary report values as 'updated'", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const destination = quakeDraft({
      key,
      time,
      announcedTime: time,
      telegramId: "destination-id",
      issueType: "Destination",
      magnitude: null,
      depthKm: null,
      maxScale: 30,
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: [{ pref: "熊本県", name: "熊本県天草・芦北", scale: 30, isArea: true }],
    });
    store.ingest(destination, "p2p");
    tick(t, 30_000);
    const detail = quakeDraft({
      key,
      time,
      announcedTime: p2pTime(-25_000),
      issueType: "DetailScale",
      magnitude: 4.0,
      depthKm: 0,
      maxScale: 30,
      topPoint: "芦北町芦北",
      prefScales: [{ pref: "熊本県", scale: 30 }],
      points: [{ pref: "熊本県", name: "芦北町芦北", scale: 30, isArea: false }],
    });
    const r = store.ingest(detail, "p2p");
    assert.equal(r.change, "updated");
    const ev = r.event as { issueType: string; magnitude: number | null; points: unknown[] };
    assert.equal(ev.issueType, "DetailScale");
    assert.equal(ev.magnitude, 4.0);
    // 📌 速報・詳細の観測点は和集合で残る
    assert.equal(ev.points.length, 2);
  });

  test("a tsunami outlook change is 'updated', and a later 'Checking' never reverts it", (t) => {
    pinClock(t);
    const store = new EventStore();
    const time = p2pTime(-60_000);
    const key = `551:${time}|@35.7,139.7`;
    const checking = quakeDraft({ key, time, announcedTime: time, tsunamiKind: "Checking" });
    store.ingest(checking, "p2p");
    tick(t, 30_000);
    const warning = quakeDraft({ key, time, announcedTime: p2pTime(-25_000), tsunamiKind: "Warning" });
    const r = store.ingest(warning, "p2p");
    assert.equal(r.change, "updated");
    assert.equal((r.event as { tsunamiKind: string }).tsunamiKind, "Warning");
    tick(t, 30_000);
    // 📌 同じ電文の再配信が未確定の見通しで作り直されても、確定した
    // 見通しは巻き戻らない (発表時刻も同一 = 同一電文のため)
    const stale = quakeDraft({ key, time, announcedTime: warning.announcedTime, tsunamiKind: "Checking" });
    const again = store.ingest(stale, "p2p");
    assert.equal(again.change, "none");
    assert.equal((store.getEvent(key) as { tsunamiKind: string }).tsunamiKind, "Warning");
  });
});

describe("warning snapshots", () => {
  test("disappeared areas are released once and removed; unfetched scopes are kept", (t) => {
    pinClock(t);
    const store = new EventStore();
    const areaB = warningDraft(BASE_MS, {
      key: "warning:130000:13102",
      areaCode: "13102",
      areaName: "中央区",
    });
    const other = warningDraft(BASE_MS, {
      key: "warning:140000:14101",
      officeCode: "140000",
      prefName: "神奈川県",
      areaCode: "14101",
      areaName: "横浜市鶴見区",
    });
    const first = store.applyWarningSnapshot([warningDraft(BASE_MS), areaB, other], ["130000", "140000"]);
    assert.equal(first.filter((r) => r.change === "new").length, 3);

    tick(t, 60_000);
    // 📌 130000 の集合から中央区が消えた (取得成功)。140000 は今回未取得
    const second = store.applyWarningSnapshot([warningDraft(BASE_MS)], ["130000"]);
    const released = second.filter((r) => (r.event as WarningEvent).released);
    assert.equal(released.length, 1);
    assert.equal(released[0].change, "updated");
    assert.equal((released[0].event as WarningEvent).warnings.length, 0);
    assert.equal((released[0].event as WarningEvent).maxSeverity, 0);
    // 📌 ストアには千代田区と、未取得スコープの横浜市鶴見区だけが残る
    assert.equal(store.counts().warning, 2);
    assert.ok(store.getEvent("warning:130000:13101"));
    assert.ok(store.getEvent("warning:140000:14101"));
  });

  test("an unchanged snapshot produces no results", (t) => {
    pinClock(t);
    const store = new EventStore();
    store.applyWarningSnapshot([warningDraft(BASE_MS)], ["130000"]);
    tick(t, 60_000);
    const again = store.applyWarningSnapshot([warningDraft(BASE_MS)], ["130000"]);
    assert.equal(again.length, 0);
  });
});

describe("persistence", () => {
  test("events round-trip through the file, excluding river and dam", (t) => {
    pinClock(t);
    const dir = mkdtempSync(join(tmpdir(), "aas-store-"));
    const file = join(dir, "events.json");
    const store = new EventStore({ filePath: file });
    store.ingest(quakeDraft(), "p2p");
    store.ingest(riverDraft(), "kawabou");
    store.saveNow();
    const saved = JSON.parse(readFileSync(file, "utf8")) as { kind: string }[];
    assert.deepEqual(
      saved.map((e) => e.kind),
      ["quake"],
    );
    const restored = new EventStore({ filePath: file });
    restored.load();
    assert.equal(restored.counts().quake, 1);
    assert.equal(restored.counts().river, 0);
  });

  test("a corrupt file loads as empty without throwing", (t) => {
    pinClock(t);
    const dir = mkdtempSync(join(tmpdir(), "aas-store-"));
    const file = join(dir, "events.json");
    writeFileSync(file, "{ not json", "utf8");
    const store = new EventStore({ filePath: file });
    store.load();
    assert.equal(store.counts().total, 0);
  });
});

describe("caps and snapshot", () => {
  test("per-kind caps drop the oldest updates first", (t) => {
    pinClock(t);
    const store = new EventStore({ caps: { quake: 2 } });
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const time = p2pTime(-60_000 + i * 1000);
      const d = quakeDraft({ time, announcedTime: time, key: `551:${time}|@35.7,139.7` });
      keys.push(d.key);
      store.ingest(d, "p2p");
      tick(t, 1000);
    }
    assert.equal(store.counts().quake, 2);
    assert.equal(store.getEvent(keys[0]), undefined);
    assert.ok(store.getEvent(keys[2]));
  });

  test("snapshot replays oldest first and excludes river/dam by default", (t) => {
    pinClock(t);
    const store = new EventStore();
    const a = store.ingest(quakeDraft(), "p2p").event;
    tick(t, 1000);
    const bDraft = quakeDraft({
      time: p2pTime(-30_000),
      announcedTime: p2pTime(-30_000),
      key: `551:${p2pTime(-30_000)}|@36.7,139.7`,
      lat: 36.7,
    });
    const b = store.ingest(bDraft, "p2p").event;
    store.ingest(riverDraft(), "kawabou");
    assert.deepEqual(
      store.snapshot().map((e) => e.key),
      [a.key, b.key],
    );
    // 📌 除外を外せば river も含む
    assert.equal(store.snapshot(19500, new Set()).length, 3);
  });

  test("typhoon re-ingest refreshes the last-seen time without a change", (t) => {
    pinClock(t);
    const store = new EventStore();
    const draft: TyphoonDraft = {
      kind: "typhoon",
      key: "typhoon:2601",
      number: "2601",
      name: "テスト台風",
      englishName: "TEST",
      lines: ["テスト台風"],
      fields: {},
      time: "",
    };
    const first = store.ingest(draft, "jma");
    assert.equal(first.change, "new");
    tick(t, 3600_000);
    const again = store.ingest(draft, "jma");
    assert.equal(again.change, "none");
    assert.ok(again.event.updatedAt > first.event.updatedAt);
  });
});
