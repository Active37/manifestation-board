import assert from "node:assert/strict";
import test from "node:test";
import { createNamesService, normalizeName, sanitizeName } from "./service.js";

test("sanitizes and normalizes names for case-insensitive lookup", () => {
  assert.equal(sanitizeName("  <b>ＭＡＮＩＦＥＳＴ-Lion-482</b>  "), "MANIFEST-Lion-482");
  assert.equal(normalizeName("  <b>ＭＡＮＩＦＥＳＴ-Lion-482</b>  "), "manifest-lion-482");
});

test("checks name availability using normalized keys", async () => {
  const service = createNamesService(async (keys) =>
    keys.filter((key) => key === "manifest-lion-482"),
  );

  assert.equal(await service.isAvailable("Manifest-Lion-482"), false);
  assert.equal(await service.isAvailable("Calm-Owl-123"), true);
});

test("returns a generated name that is not already in use", async () => {
  const service = createNamesService(async (keys) =>
    keys.filter((key) => key === "manifest-lion-482"),
  );

  const name = await service.randomName();

  assert.match(name, /^[A-Za-z]+-[A-Za-z]+-\d{3}$/);
  assert.notEqual(normalizeName(name), "manifest-lion-482");
});

test("reports exhaustion when every generated candidate is taken", async () => {
  const service = createNamesService(async (keys) => keys);

  await assert.rejects(service.randomName(), /No names are currently available/);
});
