// ==========================================
// 🧪 テスト: P2P の変換 (551 / 552 / 556)
// ==========================================
// 📌 フィクスチャは実電文 (tests/fixtures/)。変換は純粋関数のため
// 時計固定は不要 (時刻は入力データの中だけにある)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseEews, parseQuakes, parseTsunamis } from "../src/convert/p2p.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}

describe("551 quake conversion", () => {
  test("converts a real fixture into the common format", () => {
    const quakes = parseQuakes(fixture("p2p-551.json"));
    assert.ok(quakes.length >= 1);
    const q = quakes[0];
    assert.equal(q.kind, "quake");
    assert.equal(q.hypocenter, "熊本県天草・芦北地方");
    assert.equal(q.maxScale, 20);
    assert.equal(q.foreign, false);
    // 🌍 同一視キーは groupKey 形式 (発生時刻 + 座標丸め)
    assert.equal(q.key, "551:2026/11/19 06:41:00|@32.3,130.4");
    assert.ok(q.prefScales.some((p) => p.pref === "熊本県" && p.scale === 20));
    assert.ok(q.points.some((p) => p.name === "球磨村渡" && p.scale === 20 && p.isArea === false));
    assert.equal(q.topPoint, "球磨村渡");
  });

  test("foreign quakes are flagged and keep originTime and the tsunami comment", () => {
    const quakes = parseQuakes(fixture("p2p-551-foreign.json"));
    // 📌 フィクスチャは国外2件 + 国内 (DetailScale) 1件の混在
    const foreign = quakes.filter((q) => q.foreign);
    assert.equal(foreign.length, 2);
    for (const q of foreign) {
      assert.equal(q.issueType, "Foreign");
      // 🌍 国外地震には震度概念がないため maxScale は不明センチネル
      assert.equal(q.maxScale, -1);
    }
    const domestic = quakes.filter((q) => !q.foreign);
    assert.equal(domestic.length, 1);
    assert.equal(domestic[0].issueType, "DetailScale");
    const indo = foreign.find((q) => q.hypocenter === "インドネシア付近");
    assert.ok(indo);
    assert.equal(indo.magnitude, 6.4);
    assert.equal(indo.originTime, "2026/11/19 05:58:00");
    // 📌 freeFormComment を優先し、無い電文は text へフォールバックする
    assert.equal(indo.tsunamiText, "この地震による津波の心配はありません。");
    const pacific = quakes.find((q) => q.tsunamiText === "太平洋の広域に津波発生の可能性があります。");
    assert.ok(pacific);
    assert.ok(pacific.originTime);
  });

  test("domestic telegrams without originTime / comments yield nulls", () => {
    const q = parseQuakes(fixture("p2p-551.json"))[0];
    // 📌 国内電文の eq に originTime は無く、freeFormComment は空文字のため、
    // どちらも「欠けたまま分かる形」として null になる
    assert.equal(q.originTime, null);
    assert.equal(q.tsunamiText, null);
  });

  test("a ScalePrompt-only report still carries pref scales and area points", () => {
    // 📌 速報段階の県別最大震度は prefScales と地域点 (isArea=true) として
    // イベントに含まれている。ここが欠けると経由表示で県別震度が出ない
    const data = [
      {
        id: "s1",
        issue: { time: "2026/11/20 21:47:33", type: "ScalePrompt", correct: "None" },
        time: "2026/11/20 21:47:33",
        earthquake: {
          time: "2026/11/20 21:46:00",
          maxScale: 40,
          domesticTsunami: "Checking",
          hypocenter: { name: "", magnitude: -1, depth: -1, latitude: -200, longitude: -200 },
        },
        points: [
          { pref: "熊本県", addr: "熊本県天草・芦北", scale: 40, isArea: true },
          { pref: "鹿児島県", addr: "鹿児島県薩摩", scale: 30, isArea: true },
        ],
      },
    ];
    const [q] = parseQuakes(data);
    assert.deepEqual(q.prefScales, [
      { pref: "熊本県", scale: 40 },
      { pref: "鹿児島県", scale: 30 },
    ]);
    assert.ok(q.points.length === 2 && q.points.every((p) => p.isArea));
    assert.equal(q.topPoint, "熊本県天草・芦北");
    assert.equal(q.topPointIsArea, true);
  });

  test("follow-up reports of the same foreign quake merge into one event", () => {
    const items = fixture("p2p-551-foreign.json") as Record<string, any>[];
    const indo = items.find((i) => i.earthquake?.hypocenter?.name === "インドネシア付近")!;
    assert.ok(indo);
    // 📌 同じ外国地震の続報: 発表時刻 (item.time) と電文 ID だけが違い、
    // 発生時刻 (originTime)・震源・座標は同じ
    const followUp = JSON.parse(JSON.stringify(indo)) as Record<string, any>;
    followUp.id = "foreign-followup-002";
    followUp.time = "2026/11/19 06:15:00";
    followUp.issue = { ...indo.issue, time: "2026/11/19 06:15:00" };
    const quakes = parseQuakes([indo, followUp]);
    const matches = quakes.filter((q) => q.hypocenter === "インドネシア付近");
    assert.equal(matches.length, 1);
    // 📌 キーの時刻は発生時刻 (originTime) 側になる
    assert.ok(matches[0].key.startsWith("551:2026/11/19 05:58:00|"));
  });

  test("invalid input yields an empty array", () => {
    assert.deepEqual(parseQuakes(null), []);
    assert.deepEqual(parseQuakes({}), []);
    assert.deepEqual(parseQuakes([null, { earthquake: null }]), []);
  });
});

describe("552 tsunami conversion", () => {
  test("converts the forecast keeping the top grade and area details", () => {
    const tsunamis = parseTsunamis(fixture("p2p-552.json"));
    assert.equal(tsunamis.length, 1);
    const t = tsunamis[0];
    assert.equal(t.kind, "tsunami");
    assert.equal(t.key, "552:synthetic-552-001");
    assert.equal(t.grade, "Watch");
    assert.equal(t.cancelled, false);
    assert.equal(t.areas.length, 2);
    assert.equal(t.areas[0].maxHeightLabel, "1m");
    // 🌊 予想高さの数値 (maxHeight.value) も保持する
    assert.equal(t.areas[0].maxHeightValue, 1);
    assert.equal(t.areas[1].maxHeightValue, 1);
    assert.equal(t.areas[0].arrivalLabel, "07:10");
    // 📌 第1波の condition は落とさず保持する
    assert.equal(t.areas[1].firstHeightCondition, "第1波の到達を確認");
  });
});

describe("556 EEW conversion", () => {
  test("converts the warning body (isWarn, estScale from scaleFrom, scaleTo kept)", () => {
    const eews = parseEews(fixture("p2p-556.json"));
    assert.equal(eews.length, 2);
    const first = eews.find((e) => e.serial === 1);
    assert.ok(first);
    assert.equal(first.isWarn, true);
    assert.equal(first.cancel, false);
    assert.equal(first.eventId, "20261119022225");
    assert.equal(first.estScale, 45); // areas の scaleFrom 最大値 (maxScale は 556 に無い)
    assert.equal(first.estMagnitude, 4.6);
    assert.equal(first.hypocenter, "熊本県天草・芦北地方");
    assert.equal(first.baseKey, "eew-id:20261119022225"); // eventId 優先キー
    assert.equal(first.key, first.baseKey);
    assert.ok(first.areaScales.some((a) => a.name === "熊本県天草・芦北" && a.scale === 45));
    // 📌 arrivalTime が null の地域は到達予想に入らない
    assert.equal(first.areaArrivals.length, 2);
    // 📳 地域ごとの予想震度の上限 (scaleTo) を保持する。99 は「〜程度以上」
    const amakusa = first.areaScales.find((a) => a.name === "熊本県天草・芦北");
    assert.equal(amakusa?.scale, 45);
    assert.equal(amakusa?.scaleTo, 99);
    const kumamoto = first.areaScales.find((a) => a.name === "熊本県熊本地方");
    assert.equal(kumamoto?.scaleTo, 40);
    // 📌 556 に最終報の概念は無いため isFinal は常に false
    assert.equal(first.isFinal, false);
  });

  test("a cancellation keeps the same baseKey with a -cancel key", () => {
    const eews = parseEews(fixture("p2p-556.json"));
    const cancel = eews.find((e) => e.serial === 2);
    assert.ok(cancel);
    assert.equal(cancel.cancel, true);
    assert.equal(cancel.key, `${cancel.baseKey}-cancel`);
    // 🌍 取消でもイベント同一性 (baseKey) は同じ
    assert.equal(cancel.baseKey, "eew-id:20261119022225");
  });

  test("without an eventId the key falls back to origin time + coordinates", () => {
    const raw = JSON.parse(JSON.stringify(fixture("p2p-556.json"))) as Record<string, any>[];
    delete raw[0].issue.eventId;
    const [eew] = parseEews(raw);
    assert.equal(eew.eventId, null);
    assert.equal(eew.baseKey, "eew-2026/11/19 02:22:25@32.3,130.5");
  });
});
