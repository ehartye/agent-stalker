// Count tokens for the Claude model family.
//
// There is no accurate local tokenizer for Claude 3/4+ (Anthropic's is
// proprietary). So: when ANTHROPIC_API_KEY is set, use Anthropic's
// count_tokens API (exact, and free — it is not billed). Otherwise fall back to
// a clearly-labelled local estimate (~4 chars/token).
//
// Usage:
//   bun count-tokens.ts <file>      # count a file
//   echo "some text" | bun count-tokens.ts   # count stdin
//
// Env:
//   ANTHROPIC_API_KEY          — when set, returns an exact count via the API
//   AGENT_STALKER_TOKEN_MODEL  — model id for the API (default claude-sonnet-4-6)

export {}; // make this a module so top-level await is allowed under tsc

const file = process.argv[2];
let text: string;
if (file && (await Bun.file(file).exists())) {
  text = await Bun.file(file).text();
} else {
  text = await new Response(Bun.stdin.stream()).text();
}

const model = process.env.AGENT_STALKER_TOKEN_MODEL || "claude-sonnet-4-6";

if (process.env.ANTHROPIC_API_KEY) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
    });
    if (res.ok) {
      const data = (await res.json()) as { input_tokens?: number };
      if (typeof data.input_tokens === "number") {
        console.log(`${data.input_tokens} tokens (exact, ${model} via count_tokens API)`);
        process.exit(0);
      }
    }
    console.error(`count_tokens API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`count_tokens API request failed: ${e}`);
  }
}

// Local estimate. Claude's tokenizer is not public; ~4 chars/token is a rough
// English approximation. Labelled clearly so it is never mistaken for exact.
const chars = text.length;
const est = Math.ceil(chars / 4);
console.log(`~${est} tokens (estimate from ${chars} chars; set ANTHROPIC_API_KEY for an exact count)`);
