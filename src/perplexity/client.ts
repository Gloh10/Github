import Perplexity from "@perplexity-ai/perplexity_ai";

let client: Perplexity | undefined;

/**
 * Lazily-constructed singleton client. Perplexity() reads PERPLEXITY_API_KEY
 * from the environment by default, so the key is never handled directly here.
 */
export function getPerplexityClient(): Perplexity {
  if (!process.env["PERPLEXITY_API_KEY"]) {
    throw new Error(
      "PERPLEXITY_API_KEY is not set. Create a key at https://console.perplexity.ai " +
        "and export it in your shell (e.g. `export PERPLEXITY_API_KEY=...`). " +
        "If a key has ever been pasted into chat, a file, or a log, rotate it in the console.",
    );
  }
  client ??= new Perplexity();
  return client;
}

export { Perplexity };
