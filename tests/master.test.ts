// ==========================================
// 🧪 テスト: マスターデータ (登録・索引・配信判断)
// ==========================================
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MASTER_DATASET_NAMES, MasterDataService } from "../src/master.js";

describe("MasterDataService with nothing registered", () => {
  test("the index lists all canonical datasets as unavailable", () => {
    const master = new MasterDataService();
    const index = master.index();
    assert.deepEqual(
      index.map((d) => d.name),
      [...MASTER_DATASET_NAMES],
    );
    assert.ok(index.every((d) => !d.available && d.count === null && d.generatedAt === null));
  });

  test("a canonical name without data is 503, an unknown name is 404", () => {
    const master = new MasterDataService();
    assert.deepEqual(master.get("stations"), { status: 503 });
    assert.deepEqual(master.get("amedas"), { status: 503 });
    assert.deepEqual(master.get("no-such-dataset"), { status: 404 });
  });
});

describe("MasterDataService registration", () => {
  test("a registered static dataset is served and indexed with its count", () => {
    const master = new MasterDataService();
    master.registerStatic("stations", {
      body: JSON.stringify({ stations: [1, 2, 3] }),
      count: 3,
      generatedAt: "2026-11-22",
    });
    const got = master.get("stations");
    assert.equal(got.status, 200);
    if (got.status === 200) assert.deepEqual(JSON.parse(got.body), { stations: [1, 2, 3] });
    const info = master.index().find((d) => d.name === "stations");
    assert.deepEqual(info, { name: "stations", count: 3, generatedAt: "2026-11-22", available: true });
    // 📌 他のデータセットは未用意のまま
    assert.deepEqual(master.get("rivers"), { status: 503 });
  });

  test("a provider returning null is unavailable until data arrives", () => {
    const master = new MasterDataService();
    let data: { body: string; count: number | null; generatedAt: string | null } | null = null;
    master.register("amedas", { getData: () => data });
    assert.deepEqual(master.get("amedas"), { status: 503 });
    assert.equal(master.index().find((d) => d.name === "amedas")?.available, false);
    data = { body: "{}", count: 1286, generatedAt: "2026-11-28T00:00:00.000Z" };
    assert.equal(master.get("amedas").status, 200);
    assert.equal(master.index().find((d) => d.name === "amedas")?.count, 1286);
  });

  test("re-registering the same name replaces the provider", () => {
    const master = new MasterDataService();
    master.registerStatic("volcanoes", { body: "old", count: 1, generatedAt: null });
    master.registerStatic("volcanoes", { body: "new", count: 2, generatedAt: null });
    const got = master.get("volcanoes");
    assert.equal(got.status, 200);
    if (got.status === 200) assert.equal(got.body, "new");
  });
});
