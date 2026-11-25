export function sanitizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim();
}
