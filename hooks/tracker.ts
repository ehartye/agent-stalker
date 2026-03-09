import { ingestEvent } from "../lib/ingest";
import { closeDb } from "../lib/db";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    process.exit(0);
  }

  try {
    const event = JSON.parse(raw);
    ingestEvent(event);
  } catch (err) {
    console.error(`agent-stalker: failed to ingest event: ${err}`);
  } finally {
    closeDb();
  }
}

main();
