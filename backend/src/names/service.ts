import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../errors.js";

const firstWords = [
  "Manifest",
  "Bright",
  "Bold",
  "Calm",
  "Curious",
  "Radiant",
  "Steady",
  "Kind",
  "Mighty",
  "Golden",
];

const secondWords = [
  "Lion",
  "Owl",
  "Falcon",
  "Tiger",
  "Dolphin",
  "Eagle",
  "Fox",
  "Panda",
  "Wolf",
  "Hawk",
];

const randomNameAttempts = 32;

export function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function createNamesService(pool: Pool) {
  async function isAvailable(name: string): Promise<boolean> {
    const nameKey = normalizeName(name);
    const result = await pool.query<{ available: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM posts WHERE name_key = $1) AS available",
      [nameKey],
    );
    return result.rows[0]?.available ?? false;
  }

  async function randomName(): Promise<string> {
    const candidates = Array.from({ length: randomNameAttempts }, () => {
      const first = firstWords[randomInt(firstWords.length)];
      const second = secondWords[randomInt(secondWords.length)];
      const number = randomInt(1000).toString().padStart(3, "0");
      return `${first}-${second}-${number}`;
    });
    const keys = [...new Set(candidates.map(normalizeName))];
    const existing = await pool.query<{ name_key: string }>(
      "SELECT name_key FROM posts WHERE name_key = ANY($1::text[])",
      [keys],
    );
    const taken = new Set(existing.rows.map((row) => row.name_key));
    const available = candidates.find((candidate) => !taken.has(normalizeName(candidate)));
    if (!available) {
      throw new ApiError(503, "No names are currently available");
    }
    return available;
  }

  return { isAvailable, randomName };
}