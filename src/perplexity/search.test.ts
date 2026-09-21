import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeByUrl, searchWeb, type SearchResult } from "./search.js";

function result(url: string, title = url): SearchResult {
  return { title, url, snippet: "snippet" };
}

test("dedupeByUrl keeps the first occurrence of each URL", () => {
  const results = [
    result("https://a.example", "A first"),
    result("https://b.example"),
    result("https://a.example", "A duplicate, lower rank"),
  ];

  const deduped = dedupeByUrl(results);

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.url, "https://a.example");
  assert.equal(deduped[0]?.title, "A first");
  assert.equal(deduped[1]?.url, "https://b.example");
});

test("dedupeByUrl returns an empty array for no results", () => {
  assert.deepEqual(dedupeByUrl([]), []);
});

test("dedupeByUrl preserves rank order for already-unique results", () => {
  const results = [result("https://a.example"), result("https://b.example"), result("https://c.example")];
  assert.deepEqual(dedupeByUrl(results), results);
});

test("searchWeb rejects more than 5 queries before making any network call", async () => {
  const sixQueries = ["a", "b", "c", "d", "e", "f"];
  await assert.rejects(() => searchWeb(sixQueries), /at most 5 queries/);
});

test("searchWeb rejects an empty query array before making any network call", async () => {
  await assert.rejects(() => searchWeb([]), /at least one query/);
});
