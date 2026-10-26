import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPapers } from "../arxiv.mjs";
import { buildScriptFromBodies } from "../script.mjs";
import { getPapers, predictTopics, writeCache } from "../prefetch.mjs";
import { pickTopic } from "../select.mjs";
import { languageOk, llmSettings, llmUnavailableReason, ungroundedNames, ungroundedNumbers, validateNarration } from "../llm.mjs";

const XML = `<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>Test Paper</title><summary>We train on 231 million cells across 40 species.</summary><published>2026-10-20T00:00:00Z</published><author><name>A. Author</name></author></entry></feed>`;
const paper = { title: "CellNet scaling", authors: ["A. Author"], abstract: "We train CellNet on 231 million cell profiles spanning 40 species using DNA-derived identities and RNA expression; two baselines are compared." };
const topic = { id: "t1", keyword: "cells", labels: { ja: "細胞", zh: "细胞", de: "Zellen", es: "Células", ru: "Клетки", it: "Cellule" } };

test("fetchPapers backs off on 429 and then succeeds", async () => {
  const sleeps = [];
  let calls = 0;
  const papers = await fetchPapers("cells", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429, headers: { get: () => "20" } }
        : { ok: true, status: 200, text: async () => XML };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(papers.length, 1);
  assert.equal(calls, 2);
  assert.equal(sleeps[0], 20000);
});

test("fetchPapers gives up after the 429 retries and returns []", async () => {
  let calls = 0;
  const papers = await fetchPapers("cells", {
    fetchImpl: async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => null } }; },
    sleep: async () => {},
  });
  assert.deepEqual(papers, []);
  assert.equal(calls, 3);
});

test("getPapers: fresh cache first, live fetch refreshes, stale cache on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rp-cache-"));
  try {
    const settings = { dir, freshHours: 12, maxAgeDays: 14, days: 3 };
    const fail = async () => { throw new Error("offline"); };
    assert.equal((await getPapers(topic, { settings, fetchImpl: fail })).origin, "none");
    await writeCache(dir, topic, [paper]);
    const fresh = await getPapers(topic, { settings, fetchImpl: fail });
    assert.equal(fresh.origin, "cache-fresh");
    const stale = await getPapers(topic, { settings: { ...settings, freshHours: 0 }, fetchImpl: fail });
    assert.equal(stale.origin, "cache-stale");
    assert.equal(stale.papers.length, 1);
    const live = await getPapers(topic, { settings: { ...settings, freshHours: 0 }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => XML }) });
    assert.equal(live.origin, "arxiv");
    // a corrupt cache file is ignored, not fatal
    await writeFile(join(dir, "t1.json"), "{", "utf8");
    assert.equal((await getPapers(topic, { settings, fetchImpl: fail })).origin, "none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("predictTopics matches what pickTopic will choose day by day", () => {
  const topics = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, keyword: `k${i}` }));
  const plan = predictTopics("2026-10-27", 4, topics, [{ date: "2026-10-26", topicId: "t1" }]);
  const history = [{ date: "2026-10-26", topicId: "t1" }];
  for (const entry of plan) {
    assert.equal(entry.topic.id, pickTopic(entry.date, topics, history).id);
    history.push({ date: entry.date, topicId: entry.topic.id });
  }
});

test("validateNarration enforces language, grounding and length", () => {
  const de = "CellNet wurde mit 231 Millionen Zellprofilen aus 40 Arten trainiert. Das Modell verbindet die aus der DNA abgeleiteten Identitäten mit der gemessenen RNA-Expression und wird mit zwei Vergleichsverfahren verglichen, die in der Arbeit beschrieben sind.";
  assert.equal(validateNarration("de", de, paper, 200).ok, true);
  assert.match(validateNarration("de", de.replace("40 Arten", "45 Arten"), paper, 200).reason, /numbers/);
  assert.match(validateNarration("de", `${de} Es übertrifft GPT-4 deutlich.`, paper, 200).reason, /names|numbers/);
  assert.match(validateNarration("it", de, paper, 200).reason, /language/);
  assert.match(validateNarration("de", "Kurz.", paper, 200).reason, /language|short/);
  assert.equal(languageOk("ja", "この研究では、2億3100万個の細胞を使って学習しました。"), true);
  assert.equal(languageOk("zh", "这项研究使用了两亿个细胞进行训练。"), true);
  assert.equal(languageOk("zh", "この研究では細胞を使います。"), false);
  assert.deepEqual(ungroundedNumbers("2億3100万個の細胞と40種", paper), []);
  assert.deepEqual(ungroundedNames("ja", "CellNet は BERT より優れています", paper), ["BERT"]);
});

test("buildScriptFromBodies uses the narration and switches the intro cue", () => {
  const options = { date: "2026-10-27", topic, papers: [paper, { ...paper, title: "Second" }], source: "arxiv" };
  const script = buildScriptFromBodies("ja", options, ["これはテスト用のナレーションです。", null]);
  assert.equal(script.papersUsed, 2);
  assert.ok(script.text.includes("これはテスト用のナレーションです。"));
  assert.ok(script.text.includes("We train CellNet"));  // null body -> abstract quote
  assert.ok(script.text.includes("ローカルAI") && script.text.includes("一部の論文は英語抄録"));  // partial cue
  const all = buildScriptFromBodies("ja", options, ["一本目の説明です。", "二本目の説明です。"]);
  assert.ok(all.text.includes("ローカルAI") && !all.text.includes("一部の論文は英語抄録"));
});

test("LLM is off by default and a missing model is reported, not thrown", () => {
  assert.equal(llmSettings({}).enabled, false);
  assert.match(llmUnavailableReason(llmSettings({})), /disabled/);
  const reason = llmUnavailableReason(llmSettings({ PODCAST_SCRIPT_LLM: "1", PODCAST_LLM_SERVER: "/nonexistent/llama-server" }));
  assert.match(reason, /not found/);
});

test("Spanish DNA/RNA abbreviations and CJK man-units are not flagged", () => {
  assert.deepEqual(ungroundedNames("es", "Usa identidades derivadas del ADN y la expresión de ARN.", paper), []);
  assert.deepEqual(ungroundedNumbers("使用了2.31亿个细胞，覆盖40个物种。", paper), []);
  assert.deepEqual(ungroundedNumbers("約 2 億 3100 万個の細胞と 40 種。", paper), []);
  assert.notDeepEqual(ungroundedNumbers("使用了约10亿个细胞。", paper), []);
});
