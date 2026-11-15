/** The shared name normalization used by Games, Tags, and Smart Collections (§2.7). */
export function normalizeNameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}
