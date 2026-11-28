// ==========================================
// 🧪 テスト: JMA XML ソース (既読管理・再試行・永続化)
// ==========================================
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JmaXmlSource } from "../src/sources/jma-xml.js";

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

const FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/extra.xml";
const SEDIMENT_URL = "https://www.data.jma.go.jp/developer/xml/data/20261122142857_0_VXWW50_150000.xml";
const TORNADO50_URL = "https://www.data.jma.go.jp/developer/xml/data/20261124090308_0_VPHW50_130000.xml";
const TORNADO51_URL = "https://www.data.jma.go.jp/developer/xml/data/20261124090309_0_VPHW51_130000.xml";
const VOLCANO_URL = "https://www.data.jma.go.jp/developer/xml/data/20261126020045_0_VFVO53_010000.xml";
const LINEAR_URL = "https://www.data.jma.go.jp/developer/xml/data/20261126015821_0_VPFJ50_473000.xml";

// 📚 フィクスチャのフィードが指す URL を、対応する電文フィクスチャへ割り当てる
const BODIES: Record<string, string> = {
  [SEDIMENT_URL]: "jma-xml-vxww50-sediment.xml",
  [TORNADO50_URL]: "jma-xml-vphw50-tornado.xml",
  [TORNADO51_URL]: "jma-xml-vphw51-tornado.xml",
  [VOLCANO_URL]: "jma-xml-vfvo53-volcano.xml",
  [LINEAR_URL]: "jma-xml-vpfj50-linear-rain.xml",
};

function stubFetchText(fetched: string[], failUrls: Set<string> = new Set()): (url: string) => Promise<string> {
  return async (url: string) => {
    if (url === FEED_URL) return fixtureText("jma-xml-feed.xml");
    const name = BODIES[url];
    if (!name) throw new Error(`unexpected fetch: ${url}`);
    fetched.push(url);
    if (failUrls.has(url)) throw new Error("body fetch failed");
    return fixtureText(name);
  };
}

test("JMA XML: フィードの未読 entry が変換され、対象外コードは本文を取得しない", async () => {
  const fetched: string[] = [];
  const source = new JmaXmlSource({ fetchText: stubFetchText(fetched) });
  const result = await source.pollFeed(FEED_URL);
  // 📌 対象は5件 (VPWW53 は対象外コードのため本文を取得しない)
  assert.equal(result.fetchedEntries, 5);
  assert.equal(fetched.length, 5);
  assert.ok(!fetched.some((u) => u.includes("VPWW53")));
  assert.equal(result.failures.length, 0);
  // 🏔️ 土砂は完全集合型として分かれて返る
  assert.deepEqual(result.sedimentPrefs, ["新潟県"]);
  assert.ok(result.sedimentDrafts.length > 0);
  // 🌪️ 竜巻 (50/51) と火山と線状降水帯が下書きになる
  const kinds = result.drafts.map((d) => d.kind);
  assert.equal(kinds.filter((k) => k === "tornado").length, 2);
  assert.ok(kinds.includes("volcano"));
  assert.ok(kinds.includes("linear-rain"));
  assert.equal(source.seenCount, 5);
});

test("JMA XML: 既読の entry は2回目のポーリングで再取得しない", async () => {
  const fetched: string[] = [];
  const source = new JmaXmlSource({ fetchText: stubFetchText(fetched) });
  await source.pollFeed(FEED_URL);
  const second = await source.pollFeed(FEED_URL);
  assert.equal(second.fetchedEntries, 0);
  assert.equal(second.drafts.length, 0);
  assert.equal(fetched.length, 5);
});

test("JMA XML: 本文取得に失敗した entry は既読にせず、次回再試行する", async () => {
  const fetched: string[] = [];
  const failUrls = new Set([TORNADO50_URL]);
  const source = new JmaXmlSource({ fetchText: stubFetchText(fetched, failUrls) });
  const first = await source.pollFeed(FEED_URL);
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].entryId, TORNADO50_URL);
  assert.equal(source.seenCount, 4); // 失敗分は既読にならない
  failUrls.clear();
  const second = await source.pollFeed(FEED_URL);
  assert.equal(second.fetchedEntries, 1); // 失敗した1件だけ再試行される
  assert.equal(second.failures.length, 0);
  assert.equal(source.seenCount, 5);
});

test("JMA XML: 既読はファイルへ永続化され、再生成したソースでも効く", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2s-jma-xml-seen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seenFile = join(dir, "jma-xml-seen.json");
  const fetched: string[] = [];
  const first = new JmaXmlSource({ seenFilePath: seenFile, fetchText: stubFetchText(fetched) });
  await first.pollFeed(FEED_URL);
  assert.equal(first.seenCount, 5);
  const restored = new JmaXmlSource({ seenFilePath: seenFile, fetchText: stubFetchText(fetched) });
  assert.equal(restored.seenCount, 5);
  const result = await restored.pollFeed(FEED_URL);
  assert.equal(result.fetchedEntries, 0);
});

test("JMA XML: フィード自体の取得失敗は例外になり、既読は変わらない", async () => {
  const source = new JmaXmlSource({
    fetchText: async () => {
      throw new Error("feed down");
    },
  });
  await assert.rejects(() => source.pollFeed(FEED_URL), /feed down/);
  assert.equal(source.seenCount, 0);
});
