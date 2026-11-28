// ==========================================
// 🧪 テスト: 取り込みソースの取得層 (警報・河川・熱中症・解決器)
// ==========================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JmaAreaNameResolver, fetchWarningSnapshot } from "../src/sources/jma.js";
import { KawabouMasterResolver, fetchRiverSnapshot } from "../src/sources/kawabou.js";
import { fetchHeatSnapshot } from "../src/sources/wbgt.js";
import { buildWarningUrl } from "../src/convert/jma.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}
function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

test("警報: 官署単位の部分失敗を許し、成功分だけがスナップショットになる", async () => {
  const warning = fixture("jma-warning-130000.json");
  const snapshot = await fetchWarningSnapshot({
    officeCodes: ["130000", "140000"],
    fetchJson: async (url) => {
      if (url === buildWarningUrl("130000")) return warning;
      throw new Error("office down");
    },
  });
  assert.deepEqual(snapshot.fetchedOfficeCodes, ["130000"]);
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.failures[0].officeCode, "140000");
  assert.equal(snapshot.drafts.length, 2);
});

test("警報: 区域名リゾルバが area.json の名前で区域名を解決する", async () => {
  const resolver = new JmaAreaNameResolver();
  resolver.loadFromData(fixture("jma-area.json"));
  assert.equal(resolver.resolve("130010"), "東京地方");
  assert.equal(resolver.resolve("999999"), undefined);
  const snapshot = await fetchWarningSnapshot({
    officeCodes: ["130000"],
    resolver,
    fetchJson: async () => fixture("jma-warning-130000.json"),
  });
  assert.ok(snapshot.drafts.every((d) => d.areaName === "東京地方" || d.areaName === "小笠原諸島"));
});

test("警報: area.json の取得に失敗してもリゾルバは例外にせず取り込みを続ける", async () => {
  const resolver = new JmaAreaNameResolver({
    fetchJson: async () => {
      throw new Error("area down");
    },
  });
  await resolver.ensureLoaded(); // 例外にならない
  assert.equal(resolver.resolve("130010"), undefined);
});

test("熱中症: 候補を順に試し、取得できた CSV を変換する。全滅なら null", async () => {
  const csv = fixtureText("wbgt-alert-20260815-17.csv");
  // 📌 発表ファイルの候補は時刻依存のため、基準時刻をフィクスチャの日に固定する
  const now = new Date("2026-08-15T18:00:00+09:00");
  let calls = 0;
  const drafts = await fetchHeatSnapshot({
    now,
    fetchText: async () => {
      calls += 1;
      if (calls < 3) throw new Error("not found");
      return csv;
    },
  });
  assert.ok(drafts);
  assert.ok(drafts.length > 0);
  assert.equal(calls, 3);
  const none = await fetchHeatSnapshot({
    now,
    fetchText: async () => {
      throw new Error("not found");
    },
  });
  assert.equal(none, null);
});

test("河川: 現在値がマスタ解決つきで変換され、水系単位の失敗は failures に残る", async () => {
  const fetchJson = async (url: string): Promise<unknown> => {
    if (url.includes("tmCrntTime")) return { crntObsTime: "2026/11/26 11:25" };
    if (url.includes("rsyslist")) return fixture("kawabou-tm-rsyslist-83030000.json");
    if (url.includes("idx/rsys/rsys")) return fixture("kawabou-rsys-83030000.json");
    if (url.includes("rvrlist")) return fixture("kawabou-rvrlist-83030001.json");
    throw new Error(`unexpected fetch: ${url}`);
  };
  const resolver = new KawabouMasterResolver({ fetchJson });
  resolver.loadRsysCodes([83030000]);
  const snapshot = await fetchRiverSnapshot({ resolver, fetchJson });
  assert.equal(snapshot.fetchedSystems, 1);
  assert.equal(snapshot.failures.length, 0);
  assert.ok(snapshot.riverDrafts.length + snapshot.damDrafts.length > 0);
  assert.ok(snapshot.damDrafts.every((d) => d.systemName === "多摩川"));

  const failing = await fetchRiverSnapshot({
    resolver,
    fetchJson: async (url) => {
      if (url.includes("rsyslist")) throw new Error("system down");
      return fetchJson(url);
    },
  });
  assert.equal(failing.fetchedSystems, 0);
  assert.equal(failing.failures.length, 1);
  assert.equal(failing.failures[0].rsysCode, 83030000);
});

test("河川: マスタ取得に失敗しても解決器は例外にせず、フォールバックで続ける", async () => {
  const resolver = new KawabouMasterResolver({
    fetchJson: async () => {
      throw new Error("master down");
    },
  });
  const idx = await resolver.ensureRsysIndex(83030000);
  assert.equal(idx.systemName, "");
  const master = await resolver.ensureRiverMaster(83030001);
  assert.equal(master.stg.size, 0);
});
