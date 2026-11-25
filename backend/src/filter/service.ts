const substitutions: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "@": "a",
  "$": "s",
};

export type GoalFilterResult =
  | { flagged: false }
  | { flagged: true; reason: "banned_term" | "gibberish" };

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[01345@$]/g, (character) => substitutions[character])
    .replace(/(?<=\p{L})[\s\p{P}\p{S}]+(?=\p{L})/gu, "");
}

function isGibberish(value: string): boolean {
  const words = value.normalize("NFKC").toLowerCase().match(/\p{L}+/gu) ?? [];

  return words.some(
    (word) =>
      (word.length >= 12 && !/[aeiou]/.test(word)) || /(.)\1{4,}/u.test(word),
  );
}

export function filterGoal(goal: string, bannedTerms: string[]): GoalFilterResult {
  const normalizedGoal = normalizeForMatch(goal);
  const hasBannedTerm = bannedTerms.some((term) => {
    const normalizedTerm = normalizeForMatch(term);
    return normalizedTerm.length > 0 && normalizedGoal.includes(normalizedTerm);
  });

  if (hasBannedTerm) {
    return { flagged: true, reason: "banned_term" };
  }

  if (isGibberish(goal)) {
    return { flagged: true, reason: "gibberish" };
  }

  return { flagged: false };
}
