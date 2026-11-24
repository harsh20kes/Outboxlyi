interface GmailTokenEntry {
  accessToken: string;
  gmailEmail: string | null;
  expiresAt: number;
}

// Ephemeral RAM-only store for client-provided Google OAuth Gmail access tokens.
// Tokens are never persisted to disk, database, or Redis, and expire after 50 minutes.
const gmailTokenMap = new Map<number, GmailTokenEntry>();

const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000;

export function setGmailToken(
  userId: number,
  accessToken: string,
  gmailEmail: string | null = null,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS
): void {
  const trimmed = accessToken.trim();
  if (!trimmed) return;

  gmailTokenMap.set(userId, {
    accessToken: trimmed,
    gmailEmail,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getGmailToken(userId: number): GmailTokenEntry | null {
  const entry = gmailTokenMap.get(userId);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    gmailTokenMap.delete(userId);
    return null;
  }

  return entry;
}

export function clearGmailToken(userId: number): void {
  gmailTokenMap.delete(userId);
}
