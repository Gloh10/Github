# Github
.github/workflows/claude.yml

## Perplexity Search API

Programmatic web search via the [Perplexity Search API](https://docs.perplexity.ai/docs/search/quickstart), using the official `@perplexity-ai/perplexity_ai` SDK.

Setup: create a key at https://console.perplexity.ai and export it — `export PERPLEXITY_API_KEY=...` — never commit it or paste it into chat/logs.

```ts
import { searchWeb } from "./src/perplexity/search.js";

const results = await searchWeb("latest AI developments", { max_results: 5 });
// results: deduped-by-URL array of { title, url, snippet, date?, last_updated? }

// Up to 5 queries in one request, merged and deduped by URL:
const merged = await searchWeb(["renewable energy trends", "solar power innovations"]);
```

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run smoke-test` (requires `PERPLEXITY_API_KEY`, makes one real request).

