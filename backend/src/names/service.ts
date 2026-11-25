import { randomInt } from "node:crypto";
import { httpError } from "../errors.js";
import { sanitizeText } from "../text.js";

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

export type NameKeyLookup = (nameKeys: string[]) => Promise<string[]>;

export function sanitizeName(value: string): string {
  return sanitizeText(value);
}

export function normalizeName(value: string): string {
  return sanitizeName(value).toLowerCase();
}

export function createNamesService(findNameKeys: NameKeyLookup) {
  async function isAvailable(name: string): Promise<boolean> {
    const key = normalizeName(name);
    const existing = await findNameKeys([key]);
    return !existing.includes(key);
  }

  async function randomName(): Promise<string> {
    const candidates = Array.from({ length: randomNameAttempts }, () => {
      const first = firstWords[randomInt(firstWords.length)];
      const second = secondWords[randomInt(secondWords.length)];
      const number = randomInt(1000).toString().padStart(3, "0");
      return `${first}-${second}-${number}`;
    });
    const keys = candidates.map(normalizeName);
    const existing = new Set(await findNameKeys([...new Set(keys)]));
    const availableIndex = keys.findIndex((key) => !existing.has(key));

    if (availableIndex === -1) {
      throw httpError(503, "No names are currently available");
    }

    return candidates[availableIndex];
  }

  return { isAvailable, randomName };
}

export type NamesService = ReturnType<typeof createNamesService>;
