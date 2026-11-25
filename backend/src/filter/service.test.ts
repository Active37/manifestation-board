import assert from "node:assert/strict";
import test from "node:test";
import { filterGoal, normalizeForMatch } from "./service.js";

test("normalizes substitutions and punctuation between letters", () => {
  assert.equal(normalizeForMatch("0-1.3 4/5@$"), "oieasas");
  assert.equal(normalizeForMatch("b.r1ght"), "bright");
});

test("flags banned terms after normalization", () => {
  assert.deepEqual(filterGoal("Make a b.r1ght plan", ["bright"]), {
    flagged: true,
    reason: "banned_term",
  });
});

test("ignores empty normalized banned terms", () => {
  assert.deepEqual(filterGoal("Make a clear plan", ["---"]), { flagged: false });
});

test("flags only the selected conservative gibberish patterns", () => {
  assert.deepEqual(filterGoal("bcdfghjklmnp", []), {
    flagged: true,
    reason: "gibberish",
  });
  assert.deepEqual(filterGoal("hello zzzzz", []), {
    flagged: true,
    reason: "gibberish",
  });
  assert.deepEqual(filterGoal("strengths", []), { flagged: false });
  assert.deepEqual(filterGoal("bcdfghjklmn", []), { flagged: false });
});

test("does not flag ordinary goals without banned terms", () => {
  assert.deepEqual(filterGoal("I want to finish my semester project.", []), {
    flagged: false,
  });
});
