// ==========================================
// 🧪 テスト: マスターデータの実データ登録 (静的 + AMeDAS)
// ==========================================
// 📌 実データ (data/master/) の件数・形式は集約の正しさの固定点。
// データ再生成で件数が変わったらここも合わせて直す。
// AMeDAS は取得をモックし、未取得 = 未用意 (503) の契約を確認する
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { MasterDataService } from "../src/master.js";
import { AmedasTable, registerMasterData } from "../src/master-data.js";
import { createA2sServer, type A2sServer } from "../src/server.js";
import { EventStore } from "../src/store.js";

// 📚 実データ (data/master/) の期待件数
const EXPECTED_COUNTS: Record<string, number> = {
  stations: 4361,
  "station-prefs": 2845,
  "tsunami-stations": 239,
  "tsunami-zones": 66,
  coastline: 66,
  "eew-polygons": 188,
  volcanoes: 55,
  rivers: 284,
};

describe("static datasets (real data)", () => {
  test("all static datasets load with the expected counts and shapes", () => {
    const master = new MasterDataService();
    registerMasterData(master, {
      fetchJson: async () => {
        throw new Error("unused");
      },
    });
    const index = master.index();
    assert.equal(index.length, 9);
    for (const [name, count] of Object.entries(EXPECTED_COUNTS)) {
      const info = index.find((d) => d.name === name);
      assert.ok(info, `${name} が索引に無い`);
      assert.equal(info.available, true, `${name} が未配信`);
      assert.equal(info.count, count, `${name} の件数`);
      assert.ok(info.generatedAt, `${name} の generatedAt が無い`);

      const got = master.get(name);
      assert.equal(got.status, 200, `${name} が取得できない`);
      if (got.status !== 200) continue;
      const data = JSON.parse(got.body) as Record<string, unknown>;
      if (name === "stations") {
        const stations = data.stations as { addr: string; lat: number; lon: number }[];
        assert.equal(stations.length, count);
        assert.equal(typeof stations[0].addr, "string");
        assert.equal(typeof stations[0].lat, "number");
        assert.equal(typeof stations[0].lon, "number");
      }
      if (name === "station-prefs") {
        const prefs = data.prefs as Record<string, string>;
        assert.equal(Object.keys(prefs).length, count);
        assert.ok(Object.values(prefs).every((v) => typeof v === "string"));
      }
      if (name === "tsunami-stations") {
        const stations = data.stations as { no: number; code: string; name: string }[];
        assert.equal(stations.length, count);
        assert.equal(typeof stations[0].code, "string");
        assert.equal(typeof stations[0].name, "string");
      }
      if (name === "volcanoes") {
        const volcanoes = data.volcanoes as { name: string; lat: number; lon: number }[];
        assert.equal(volcanoes.length, count);
        assert.equal(typeof volcanoes[0].name, "string");
      }
    }
    // 🌋 AMeDAS は未取得の間は索引で未配信になり、単体取得は 503
    const amedas = index.find((d) => d.name === "amedas");
    assert.equal(amedas?.available, false);
    assert.equal(amedas?.count, null);
    assert.deepEqual(master.get("amedas"), { status: 503 });
    // ❓ 存在しない名前は 404
    assert.deepEqual(master.get("no-such-dataset"), { status: 404 });
  });

  test("a dataset whose file is missing stays unavailable, the rest still load", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2s-master-"));
    writeFileSync(
      join(dir, "volcanoes.json"),
      JSON.stringify({ source: "test", generatedAt: "2026-01-01", volcanoes: [{ name: "富士山", lat: 35.361, lon: 138.728 }] }),
    );
    const master = new MasterDataService();
    registerMasterData(master, {
      dir,
      fetchJson: async () => {
        throw new Error("unused");
      },
    });
    const index = master.index();
    assert.equal(index.find((d) => d.name === "volcanoes")?.count, 1);
    assert.equal(index.find((d) => d.name === "stations")?.available, false);
    // 📌 Phase 1 レジストリの契約: 正規名で未用意なら 503
    assert.deepEqual(master.get("stations"), { status: 503 });
    assert.equal(master.get("volcanoes").status, 200);
  });
});

describe("AMeDAS provider", () => {
  test("loads via a mocked fetch, stays unavailable on failure, keeps data after later failures", async () => {
    const tableData = { "11001": { kjName: "宗谷岬" }, "11016": { kjName: "稚内" } };
    const ok = new AmedasTable({ fetchJson: async () => tableData });
    assert.equal(ok.available, false);
    assert.equal(ok.getData(), null);
    await ok.ensureLoaded();
    assert.equal(ok.available, true);
    const data = ok.getData();
    assert.ok(data);
    assert.equal(data.count, 2);
    assert.ok(data.generatedAt);
    assert.deepEqual(JSON.parse(data.body), tableData);

    const ng = new AmedasTable({
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    await ng.ensureLoaded();
    assert.equal(ng.available, false);
    assert.equal(ng.getData(), null);

    // 📌 形式が想定外 (配列・空) は取り込まない
    assert.equal(ok.loadFromData([1, 2, 3]), false);
    assert.equal(ok.loadFromData({}), false);
    assert.equal(ok.getData()?.count, 2);

    // 📌 取得済みの後の再取得失敗では前回分を保持する (ttl 0 で毎回再取得)
    let fail = false;
    const keep = new AmedasTable({
      ttlMs: 0,
      fetchJson: async () => {
        if (fail) throw new Error("network down");
        return tableData;
      },
    });
    await keep.ensureLoaded();
    assert.equal(keep.available, true);
    fail = true;
    await keep.ensureLoaded();
    assert.equal(keep.available, true);
    assert.equal(keep.getData()?.count, 2);
  });

  test("a loaded table is served through the registry", () => {
    const master = new MasterDataService();
    const { amedas } = registerMasterData(master, {
      fetchJson: async () => {
        throw new Error("unused");
      },
    });
    assert.equal(amedas.loadFromData({ "11001": { kjName: "宗谷岬" } }), true);
    const got = master.get("amedas");
    assert.equal(got.status, 200);
    if (got.status === 200) assert.deepEqual(JSON.parse(got.body), { "11001": { kjName: "宗谷岬" } });
    assert.equal(master.index().find((d) => d.name === "amedas")?.count, 1);
  });
});

describe("HTTP serving", () => {
  test("the index and datasets are served; AMeDAS is 503 while unfetched", async () => {
    const master = new MasterDataService();
    registerMasterData(master, {
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    const a2s: A2sServer = createA2sServer({
      store: new EventStore(),
      token: "owner-secret",
      version: "0.1.0-test",
      statusProvider: () => ({}),
      master,
    });
    await new Promise<void>((resolve) => a2s.server.listen(0, "127.0.0.1", resolve));
    const port = (a2s.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: "Bearer owner-secret" };
    try {
      assert.equal((await fetch(`${base}/v1/master`)).status, 401);
      const idxRes = await fetch(`${base}/v1/master`, { headers: auth });
      assert.equal(idxRes.status, 200);
      const idx = (await idxRes.json()) as { datasets: { name: string; count: number | null; available: boolean }[] };
      assert.equal(idx.datasets.length, 9);
      for (const [name, count] of Object.entries(EXPECTED_COUNTS)) {
        assert.equal(idx.datasets.find((d) => d.name === name)?.count, count, `${name} の索引件数`);
      }
      assert.equal(idx.datasets.find((d) => d.name === "amedas")?.available, false);

      const stRes = await fetch(`${base}/v1/master/stations`, { headers: auth });
      assert.equal(stRes.status, 200);
      const st = (await stRes.json()) as { stations: unknown[] };
      assert.equal(st.stations.length, EXPECTED_COUNTS.stations);

      const amRes = await fetch(`${base}/v1/master/amedas`, { headers: auth });
      assert.equal(amRes.status, 503);
      assert.deepEqual(await amRes.json(), { error: "master_unavailable", dataset: "amedas" });
    } finally {
      await a2s.close();
    }
  });
});
