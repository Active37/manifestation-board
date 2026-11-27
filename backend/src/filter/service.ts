const substitutions: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "@": "a",
  "$": "s",
};

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[01345@$]/g, (character) => substitutions[character])
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isGibberish(value: string): boolean {
  const words = value.normalize("NFKC").toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some(
    (word) =>
      (word.length >= 12 && !/[aeiou]/.test(word)) || /(.)\1{4,}/u.test(word),
  );
}

export function containsBannedTerm(value: string, terms: string[]): boolean {
  const normalizedValue = normalizeForMatch(value);
  return terms.some((term) => {
    const normalizedTerm = normalizeForMatch(term);
    return normalizedTerm.length > 0 && normalizedValue.includes(normalizedTerm);
  });
}

export function filterGoal(
  value: string,
  terms: string[],
): { flagged: boolean; reason: "banned_term" | "gibberish" | null } {
  if (containsBannedTerm(value, terms)) {
    return { flagged: true, reason: "banned_term" };
  }
  if (isGibberish(value)) {
    return { flagged: true, reason: "gibberish" };
  }
  return { flagged: false, reason: null };
}