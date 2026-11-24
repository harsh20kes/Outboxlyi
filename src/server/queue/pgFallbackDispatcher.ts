import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  emailBatches,
  emails,
  rateLimitLogs,
  senders,
} from '../../db/schema.ts';
import { env } from '../config/env.ts';
import { updateEmailIndexStatus } from '../services/elasticsearch.ts';
import { sendEmailViaSender } from '../services/mailer.ts';
import { getRedisStatus } from '../services/redis.ts';
import { sendSlackRateLimitAlert } from '../services/slack.ts';

let pendingTimer: NodeJS.Timeout | null = null;
let isProcessing = false;
let rerunRequested = false;

const lastSendAtBySender = new Map<number, number>();
const slackNotifiedWindowKeys = new Set<string>();

function getHourWindowStart(date: Date): Date {
  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

function getHourWindowKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

function getNextHourStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

export async function initPgFallbackDispatcher(): Promise<void> {
  if (getRedisStatus().connected) {
    return;
  }

  // Recover any interrupted 'processing' rows from an abrupt restart
  await db
    .update(emails)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(and(eq(emails.status, 'processing'), isNull(emails.sentAt)));

  await scheduleNextWakeup();
}

export async function notifyPgDispatcher(): Promise<void> {
  if (getRedisStatus().connected) {
    return;
  }
  await scheduleNextWakeup();
}

async function scheduleNextWakeup(): Promise<void> {
  if (getRedisStatus().connected) return;

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  try {
    const [nextRow] = await db
      .select({ nextAt: sql<Date | null>`MIN(${emails.scheduledAt})` })
      .from(emails)
      .where(
        and(
          inArray(emails.status, ['scheduled', 'delayed']),
          isNull(emails.sentAt)
        )
      );

    if (!nextRow?.nextAt) {
      return;
    }

    const nextMs = new Date(nextRow.nextAt).getTime();
    const delayMs = Math.max(0, nextMs - Date.now());
    const clampedDelay = Math.min(delayMs, 2_147_483_647);

    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void processDuePgEmails();
    }, clampedDelay);
  } catch (error) {
    console.error('Failed to schedule next PG dispatcher wakeup:', error);
  }
}

async function processDuePgEmails(): Promise<void> {
  if (getRedisStatus().connected) return;

  if (isProcessing) {
    rerunRequested = true;
    return;
  }

  isProcessing = true;
  try {
    const staleCutoff = new Date(Date.now() - 45_000);
    await db
      .update(emails)
      .set({ status: 'scheduled', updatedAt: new Date() })
      .where(
        and(
          eq(emails.status, 'processing'),
          isNull(emails.sentAt),
          lte(emails.updatedAt, staleCutoff)
        )
      );

    const now = new Date();
    const dueRows = await db
      .select({
        email: emails,
        batchDelayMs: emailBatches.delayBetweenMs,
        batchHourlyLimit: emailBatches.hourlyLimit,
      })
      .from(emails)
      .innerJoin(emailBatches, eq(emails.batchId, emailBatches.id))
      .where(
        and(
          inArray(emails.status, ['scheduled', 'delayed']),
          isNull(emails.sentAt),
          lte(emails.scheduledAt, now)
        )
      )
      .orderBy(asc(emails.scheduledAt), asc(emails.id))
      .limit(env.workerConcurrency);

    if (dueRows.length === 0) {
      return;
    }

    // Reserve per-sender spacing synchronously before launching concurrent SMTP sends
    const immediateRows: typeof dueRows = [];
    const deferredRows: Array<{ id: number; targetTs: number }> = [];
    const baseNowMs = Date.now();

    for (const row of dueRows) {
      const effectiveDelayMs = Math.max(
        row.batchDelayMs || 0,
        env.minDelayBetweenEmailsMs
      );
      const lastSentMs = lastSendAtBySender.get(row.email.senderId) ?? 0;
      if (effectiveDelayMs > 0 && baseNowMs - lastSentMs < effectiveDelayMs) {
        const nextAllowedTs = lastSentMs + effectiveDelayMs;
        lastSendAtBySender.set(row.email.senderId, nextAllowedTs);
        deferredRows.push({ id: row.email.id, targetTs: nextAllowedTs });
      } else {
        lastSendAtBySender.set(row.email.senderId, baseNowMs);
        immediateRows.push(row);
      }
    }

    if (deferredRows.length > 0) {
      await Promise.all(
        deferredRows.map(async ({ id, targetTs }) => {
          await db
            .update(emails)
            .set({
              scheduledAt: new Date(targetTs),
              updatedAt: new Date(),
            })
            .where(eq(emails.id, id));
          await updateEmailIndexStatus(id, {
            scheduledAt: new Date(targetTs).toISOString(),
          });
        })
      );
    }

    await Promise.all(
      immediateRows.map(async ({ email: emailRow, batchDelayMs, batchHourlyLimit }) => {
        const [senderRow] = await db
          .select()
          .from(senders)
          .where(eq(senders.id, emailRow.senderId))
          .limit(1);

        if (!senderRow) {
          await db
            .update(emails)
            .set({
              status: 'failed',
              errorMessage: 'Sender account no longer exists',
              updatedAt: new Date(),
            })
            .where(eq(emails.id, emailRow.id));
          return;
        }

        const nowMs = Date.now();
        const effectiveDelayMs = Math.max(
          batchDelayMs || 0,
          env.minDelayBetweenEmailsMs
        );

        // Check hourly limit from PostgreSQL sent count in current UTC hour
        const hourStart = getHourWindowStart(new Date(nowMs));
        const hourWindow = getHourWindowKey(hourStart);
        const senderCap = senderRow.hourlyLimit ?? env.maxEmailsPerHourPerSender;
        const effectiveHourlyLimit = Math.max(
          1,
          Math.min(
            batchHourlyLimit || senderCap,
            senderCap,
            env.maxEmailsPerHourPerSender
          )
        );

        const [{ sentCount }] = await db
          .select({ sentCount: sql<number>`count(*)::int` })
          .from(emails)
          .where(
            and(
              eq(emails.senderId, senderRow.id),
              eq(emails.status, 'sent'),
              gte(emails.sentAt, hourStart)
            )
          );

        if (sentCount >= effectiveHourlyLimit) {
          const nextHourStart = getNextHourStartMs(nowMs);
          const targetTs = nextHourStart + (emailRow.id % 100) * Math.max(effectiveDelayMs, 250);

          await db
            .update(emails)
            .set({
              status: 'delayed',
              scheduledAt: new Date(targetTs),
              updatedAt: new Date(),
            })
            .where(eq(emails.id, emailRow.id));

          await updateEmailIndexStatus(emailRow.id, {
            status: 'delayed',
            scheduledAt: new Date(targetTs).toISOString(),
          });

          const dedupeKey = `${senderRow.id}:${hourWindow}`;
          if (!slackNotifiedWindowKeys.has(dedupeKey)) {
            slackNotifiedWindowKeys.add(dedupeKey);
            const slackSent = await sendSlackRateLimitAlert({
              userId: emailRow.userId,
              senderEmail: senderRow.email,
              senderName: senderRow.name,
              hourlyLimit: effectiveHourlyLimit,
              hourWindow,
              nextWindowIso: new Date(nextHourStart).toISOString(),
            });

            await db.insert(rateLimitLogs).values({
              userId: emailRow.userId,
              senderId: senderRow.id,
              hourWindow,
              limitValue: effectiveHourlyLimit,
              slackNotified: slackSent,
            });
          }
          return;
        }

        // Reserve spacing timestamp & atomically claim row
        lastSendAtBySender.set(senderRow.id, Date.now());

        const claimed = await db
          .update(emails)
          .set({ status: 'processing', updatedAt: new Date() })
          .where(
            and(
              eq(emails.id, emailRow.id),
              inArray(emails.status, ['scheduled', 'delayed']),
              isNull(emails.sentAt)
            )
          )
          .returning();

        if (claimed.length === 0) return;

        try {
          const { previewUrl } = await sendEmailViaSender({
            sender: senderRow,
            to: emailRow.recipientEmail,
            subject: emailRow.subject,
            body: emailRow.body,
          });

          const sentTime = new Date();
          await db
            .update(emails)
            .set({
              status: 'sent',
              sentAt: sentTime,
              etherealPreviewUrl: previewUrl,
              errorMessage: null,
              updatedAt: sentTime,
            })
            .where(eq(emails.id, emailRow.id));

          await updateEmailIndexStatus(emailRow.id, {
            status: 'sent',
            sentAt: sentTime.toISOString(),
            etherealPreviewUrl: previewUrl,
            errorMessage: null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'SMTP delivery failed';
          const nextRetry = (emailRow.retryCount ?? 0) + 1;
          const isFinal = nextRetry >= 3;

          await db
            .update(emails)
            .set({
              status: isFinal ? 'failed' : 'scheduled',
              retryCount: nextRetry,
              scheduledAt: isFinal
                ? emailRow.scheduledAt
                : new Date(Date.now() + 5000 * nextRetry),
              errorMessage: msg,
              updatedAt: new Date(),
            })
            .where(eq(emails.id, emailRow.id));

          await updateEmailIndexStatus(emailRow.id, {
            status: isFinal ? 'failed' : 'scheduled',
            errorMessage: msg,
          });
        }
      })
    );
  } finally {
    isProcessing = false;
    if (rerunRequested) {
      rerunRequested = false;
      void processDuePgEmails();
    } else {
      await scheduleNextWakeup();
    }
  }
}
