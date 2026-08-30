/** Escape a string for safe embedding as one POSIX shell argument. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
