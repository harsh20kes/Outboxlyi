import Papa from 'papaparse';

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_RECIPIENTS_PER_BATCH = 10000;

export interface ParsedLeadsResult {
  validEmails: string[];
  totalDetected: number;
  duplicateCount: number;
  invalidCount: number;
  fileName: string;
}

export async function parseLeadsFile(file: File): Promise<ParsedLeadsResult> {
  if (file.size > MAX_CSV_BYTES) {
    throw new Error('File exceeds the 5 MB size limit.');
  }

  const text = await file.text();
  if (!text.trim()) {
    throw new Error('The uploaded file is empty.');
  }

  const unique = new Set<string>();
  let totalDetected = 0;
  let duplicateCount = 0;
  let invalidCount = 0;

  const isCsv = file.name.toLowerCase().endsWith('.csv');

  if (isCsv) {
    const parsed = Papa.parse<string[]>(text, {
      skipEmptyLines: true,
    });

    const rows = parsed.data;
    if (rows.length > 0) {
      // Check if first row is a header row with an email column
      const firstRowLower = rows[0].map((c) => String(c ?? '').trim().toLowerCase());
      const emailColIndex = firstRowLower.findIndex(
        (h) => h === 'email' || h === 'email_address' || h === 'e-mail' || h === 'recipient'
      );

      const startIdx = emailColIndex !== -1 ? 1 : 0;

      for (let r = startIdx; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        if (emailColIndex !== -1) {
          const rawCell = String(row[emailColIndex] ?? '').trim().toLowerCase();
          if (!rawCell) continue;
          totalDetected++;
          if (!STRICT_EMAIL_REGEX.test(rawCell)) {
            invalidCount++;
            continue;
          }
          if (unique.has(rawCell)) {
            duplicateCount++;
          } else {
            unique.add(rawCell);
          }
        } else {
          // Scan every cell in the row for email tokens
          for (const cell of row) {
            const raw = String(cell ?? '').trim();
            if (!raw) continue;
            const matches = raw.match(EMAIL_PATTERN);
            if (matches && matches.length > 0) {
              for (const m of matches) {
                const norm = m.toLowerCase();
                totalDetected++;
                if (unique.has(norm)) {
                  duplicateCount++;
                } else {
                  unique.add(norm);
                }
              }
            } else if (raw.includes('@')) {
              totalDetected++;
              invalidCount++;
            }
          }
        }
      }
    }
  } else {
    // Plain text / comma / semicolon / whitespace separated leads
    const tokens = text
      .split(/[\r\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const matches = token.match(EMAIL_PATTERN);
      if (matches && matches.length > 0) {
        for (const m of matches) {
          const norm = m.toLowerCase();
          totalDetected++;
          if (unique.has(norm)) {
            duplicateCount++;
          } else {
            unique.add(norm);
          }
        }
      } else {
        totalDetected++;
        invalidCount++;
      }
    }
  }

  const validEmails = Array.from(unique);
  if (validEmails.length > MAX_RECIPIENTS_PER_BATCH) {
    throw new Error(
      `Detected ${validEmails.length.toLocaleString()} unique emails, exceeding the ${MAX_RECIPIENTS_PER_BATCH.toLocaleString()} recipient limit per batch.`
    );
  }

  return {
    validEmails,
    totalDetected,
    duplicateCount,
    invalidCount,
    fileName: file.name,
  };
}
