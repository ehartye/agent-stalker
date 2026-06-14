import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("hooks.json", () => {
  const raw = readFileSync(join(import.meta.dir, "hooks.json"), "utf-8");
  const config = JSON.parse(raw);

  it("every hook command is async with a numeric timeout", () => {
    const hookEvents = Object.entries(config.hooks as Record<string, any[]>);
    expect(hookEvents.length).toBeGreaterThan(0);
    for (const [eventName, matchers] of hookEvents) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.async, `${eventName} hook must be async`).toBe(true);
          expect(typeof hook.timeout, `${eventName} hook must have a numeric timeout`).toBe("number");
        }
      }
    }
  });
});
