// Ids for tabs, transfers and log lines. Not secrets, but CodeQL flagged
// Math.random() feeding values the backend is given (js/insecure-
// randomness, 31 alerts), and the system's generator costs nothing more.
// getRandomValues, not randomUUID: it needs no secure context.
export function newId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Date.now()}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
