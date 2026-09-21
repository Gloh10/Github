/**
 * Minimal real request against the live Search API. Prints only the HTTP
 * status and response shape — never the API key or full result content.
 *
 * Usage: PERPLEXITY_API_KEY=... npm run smoke-test
 */
import { getPerplexityClient, Perplexity } from "../src/perplexity/client.js";

async function main() {
  if (!process.env["PERPLEXITY_API_KEY"]) {
    console.error(
      "PERPLEXITY_API_KEY is not set. Create a key at https://console.perplexity.ai " +
        "and export it in your shell, then re-run: PERPLEXITY_API_KEY=... npm run smoke-test",
    );
    process.exitCode = 1;
    return;
  }

  const client = getPerplexityClient();

  try {
    const response = await client.search.create({
      query: "Perplexity Search API smoke test",
      max_results: 1,
    });

    console.log("Status: 200 OK");
    console.log(
      "Response shape:",
      JSON.stringify(
        {
          id: typeof response.id,
          server_time: typeof response.server_time,
          results: `array[${response.results.length}]`,
          resultShape:
            response.results[0] &&
            Object.fromEntries(
              Object.entries(response.results[0]).map(([key, value]) => [key, typeof value]),
            ),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err instanceof Perplexity.APIError) {
      if (err.status === 401) {
        console.error("Status: 401 Unauthorized — the API key is missing or invalid. Check PERPLEXITY_API_KEY.");
      } else if (err.status === 429) {
        console.error(
          "Status: 429 Rate Limited — the SDK already retries 429s with backoff by default; " +
            "this means retries were also exhausted. See https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.",
        );
      } else {
        console.error(`Status: ${err.status} — ${err.name}: ${err.message}`);
      }
    } else {
      console.error("Request failed:", err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  }
}

void main();
