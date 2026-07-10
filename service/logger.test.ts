import assert from "node:assert/strict";
import test from "node:test";

import { emitLog, serializeHttpValue, type Logger } from "./logger.js";

test("serializeHttpValue truncates binary Base64 to 100 characters", async () => {
  const serialized = await serializeHttpValue(Buffer.alloc(120, 1)) as Record<string, unknown>;
  assert.equal(String(serialized.base64).length, 100);
  assert.equal(serialized.base64Length, 160);
  assert.equal(serialized.omittedCharacters, 60);
  assert.equal(serialized.base64Truncated, true);
});

test("serializeHttpValue truncates the Base64 FormData field", async () => {
  const form = new FormData();
  form.append("base64", "a".repeat(160));
  const serialized = await serializeHttpValue(form) as {
    entries: Array<{ name: string; value: Record<string, unknown> }>;
  };
  assert.equal(String(serialized.entries[0]?.value.base64).length, 100);
  assert.equal(serialized.entries[0]?.value.omittedCharacters, 60);
});

test("serializeHttpValue truncates a Base64 data URI", async () => {
  const serialized = await serializeHttpValue(`data:image/jpeg;base64,${"a".repeat(160)}`) as Record<string, unknown>;
  assert.equal(String(serialized.base64).length, 100);
  assert.equal(serialized.mime, "image/jpeg");
  assert.equal(serialized.omittedCharacters, 60);
});

test("emitLog isolates an injected Logger failure", async () => {
  const logger: Logger = {
    log: () => { throw new Error("logger failed"); },
  };
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => { errors.push(values); };
  try {
    await assert.doesNotReject(emitLog(logger, { message: "progress", type: "info" }));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(errors.length, 1);
});
