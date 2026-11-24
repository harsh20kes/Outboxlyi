import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Router } from 'express';
import { db } from '../../db/index.ts';
import { emails, rateLimitLogs, senders } from '../../db/schema.ts';
import { env } from '../config/env.ts';
import { updateEmailIndexStatus } from '../services/elasticsearch.ts';
import { sendEmailViaSender } from '../services/mailer.ts';
import { getRedisConnection, getRedisStatus } from '../services/redis.ts';
import { sendSlackRateLimitAlert } from '../services/slack.ts';
import { initPgFallbackDispatcher } from './pgFallbackDispatcher.ts';

export const EMAIL_QUEUE_NAME = 'email-scheduler';

export interface EmailJobData {
  emailId: number;
  batchId: number;
  userId: number;
  senderId: number;
  delayBetweenMs: number;
  hourlyLimit: number;
}

let emailQueue: Queue<EmailJobData> | null = null;
let emailWorker: Worker<EmailJobData> | null = null;
let serverAdapter: ExpressAdapter | null = null;
let queueRouter: Router | null = null;

// Atomic Redis Lua script: checks current hour counter against limit and increments only if under cap
const RATE_LIMIT_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current >= limit then
  return {0, current}
end
local nextVal = redis.call('INCR', KEYS[1])
if nextVal == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return {1, nextVal}
`;

export function getHourWindowKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

export function getNextHourStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(date.getUTCHours() + 1);
  return date.getTime();
}

export async function initEmailScheduler(): Promise<void> {
  const redis = getRedisConnection();
  if (!redis || !getRedisStatus().connected) {
    console.log('Redis unavailable; using event-driven PostgreSQL persistent delayed dispatcher.');
    await initPgFallbackDispatcher();
    return;
  }

  emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: {
        age: 86400,
        count: 2000,
      },
      removeOnFail: {
        age: 7 * 86400,
        count: 1000,
      },
    },
  });

  emailQueue.on('error', (err) => {
    console.error('BullMQ queue error:', err.message);
  });

  serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });
  queueRouter = serverAdapter.getRouter() as unknown as Router;

  emailWorker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>, token?: string) => {
      return processEmailJob(job, token);
    },
    {
      connection: redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency: env.workerConcurrency,
    }
  );

  emailWorker.on('error', (err) => {
    console.error('BullMQ worker error:', err);
  });

  emailWorker.on('failed', (job, err) => {
    if (err instanceof DelayedError) return;
    console.error(`BullMQ job ${job?.id ?? 'unknown'} failed:`, err.message);
  });

  // Rehydrate any unsent scheduled/delayed jobs from PostgreSQL on startup
  await rehydratePendingEmails();
}

async function processEmailJob(
  job: Job<EmailJobData>,
  token?: string
): Promise<{ status: string; previewUrl?: string | null }> {
  const { emailId, userId, senderId, delayBetweenMs, hourlyLimit } = job.data;
  const redis = getRedisConnection();

  if (!redis) {
    throw new Error('Redis connection lost during job execution');
  }

  // 1. Fetch email and sender from PostgreSQL
  const [emailRow] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (!emailRow) {
    return { status: 'missing' };
  }

  // Strict idempotency: never re-send already sent emails
  if (emailRow.status === 'sent' || emailRow.sentAt !== null) {
    return { status: 'already_sent', previewUrl: emailRow.etherealPreviewUrl };
  }

  const [senderRow] = await db
    .select()
    .from(senders)
    .where(eq(senders.id, senderId))
    .limit(1);

  if (!senderRow) {
    await db
      .update(emails)
      .set({
        status: 'failed',
        errorMessage: 'Sender account no longer exists',
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));
    await updateEmailIndexStatus(emailId, {
      status: 'failed',
      errorMessage: 'Sender account no longer exists',
    });
    return { status: 'failed_missing_sender' };
  }

  const effectiveDelayMs = Math.max(delayBetweenMs || 0, env.minDelayBetweenEmailsMs);
  const senderCap = senderRow.hourlyLimit ?? env.maxEmailsPerHourPerSender;
  const effectiveHourlyLimit = Math.max(
    1,
    Math.min(hourlyLimit || senderCap, senderCap, env.maxEmailsPerHourPerSender)
  );

  const nowMs = Date.now();
  const hourWindow = getHourWindowKey(new Date(nowMs));
  const rateKey = `ratelimit:sender:${senderId}:${hourWindow}`;

  // 2. Enforce distributed minimum delay between sends per sender without consuming hourly quota
  if (effectiveDelayMs > 0) {
    const spacingKey = `ratelimit:spacing:${senderId}`;
    const acquiredSpacing = await redis.set(
      spacingKey,
      String(nowMs),
      'PX',
      effectiveDelayMs,
      'NX'
    );

    if (acquiredSpacing !== 'OK') {
      const pttl = await redis.pttl(spacingKey);
      const waitMs = Math.max(pttl > 0 ? pttl : effectiveDelayMs, 250);
      const targetTs = nowMs + waitMs + Math.floor(Math.random() * 150);

      await db
        .update(emails)
        .set({
          scheduledAt: new Date(targetTs),
          updatedAt: new Date(),
        })
        .where(eq(emails.id, emailId));

      await updateEmailIndexStatus(emailId, {
        scheduledAt: new Date(targetTs).toISOString(),
      });

      await job.moveToDelayed(targetTs, token);
      throw new DelayedError();
    }
  }

  // 3. Enforce distributed hourly rate limit per sender across all workers
  const rateResult = (await redis.eval(
    RATE_LIMIT_LUA,
    1,
    rateKey,
    String(effectiveHourlyLimit),
    '3700'
  )) as [number, number];

  const allowed = rateResult[0] === 1;

  if (!allowed) {
    const nextHourStart = getNextHourStartMs(nowMs);
    const nextWindowKey = getHourWindowKey(new Date(nextHourStart));
    const overflowKey = `ratelimit:overflow:${senderId}:${nextWindowKey}`;

    const overflowSlot = await redis.incr(overflowKey);
    if (overflowSlot === 1) {
      await redis.expire(overflowKey, 7200);
    }

    const extraHours = Math.floor((overflowSlot - 1) / effectiveHourlyLimit);
    const slotInHour = (overflowSlot - 1) % effectiveHourlyLimit;
    const spacingStep = Math.max(effectiveDelayMs, 250);
    const targetTs =
      nextHourStart + extraHours * 3600_000 + slotInHour * spacingStep;

    await db
      .update(emails)
      .set({
        status: 'delayed',
        scheduledAt: new Date(targetTs),
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));

    await updateEmailIndexStatus(emailId, {
      status: 'delayed',
      scheduledAt: new Date(targetTs).toISOString(),
    });

    // Send one Slack notification per sender per hour window when limit is hit
    const slackDedupeKey = `slack:ratelimit:${senderId}:${hourWindow}`;
    const shouldNotify = await redis.set(slackDedupeKey, '1', 'EX', 3700, 'NX');
    if (shouldNotify === 'OK') {
      const slackSent = await sendSlackRateLimitAlert({
        userId,
        senderEmail: senderRow.email,
        senderName: senderRow.name,
        hourlyLimit: effectiveHourlyLimit,
        hourWindow,
        nextWindowIso: new Date(nextHourStart).toISOString(),
      });

      await db.insert(rateLimitLogs).values({
        userId,
        senderId,
        hourWindow,
        limitValue: effectiveHourlyLimit,
        slackNotified: slackSent,
      });
    }

    await job.moveToDelayed(targetTs, token);
    throw new DelayedError();
  }

  // 4. Atomic claim in PostgreSQL to guarantee single-send idempotency across restarts/workers
  const claimed = await db
    .update(emails)
    .set({
      status: 'processing',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emails.id, emailId),
        inArray(emails.status, ['scheduled', 'delayed']),
        isNull(emails.sentAt)
      )
    )
    .returning();

  if (claimed.length === 0) {
    return { status: 'skipped_already_claimed' };
  }

  // 5. Send via Ethereal SMTP
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
      .where(eq(emails.id, emailId));

    await updateEmailIndexStatus(emailId, {
      status: 'sent',
      sentAt: sentTime.toISOString(),
      etherealPreviewUrl: previewUrl,
      errorMessage: null,
    });

    return { status: 'sent', previewUrl };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'SMTP delivery failed';
    const nextRetry = (emailRow.retryCount ?? 0) + 1;
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts ?? 3);

    await db
      .update(emails)
      .set({
        status: isFinalAttempt ? 'failed' : 'scheduled',
        retryCount: nextRetry,
        errorMessage: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));

    await updateEmailIndexStatus(emailId, {
      status: isFinalAttempt ? 'failed' : 'scheduled',
      errorMessage: errMsg,
    });

    throw error;
  }
}

export async function enqueueEmailJobs(
  items: Array<{
    emailId: number;
    batchId: number;
    userId: number;
    senderId: number;
    scheduledAt: Date;
    idempotencyKey: string;
    delayBetweenMs: number;
    hourlyLimit: number;
  }>
): Promise<boolean> {
  if (!emailQueue || !getRedisStatus().connected) {
    return false;
  }

  const nowMs = Date.now();
  const bulkJobs = items.map((item) => ({
    name: 'send-email',
    data: {
      emailId: item.emailId,
      batchId: item.batchId,
      userId: item.userId,
      senderId: item.senderId,
      delayBetweenMs: item.delayBetweenMs,
      hourlyLimit: item.hourlyLimit,
    },
    opts: {
      jobId: item.idempotencyKey,
      delay: Math.max(0, item.scheduledAt.getTime() - nowMs),
    },
  }));

  // Chunk addBulk calls in groups of 500 for large 1,000+ email batches
  for (let i = 0; i < bulkJobs.length; i += 500) {
    const chunk = bulkJobs.slice(i, i + 500);
    await emailQueue.addBulk(chunk);
  }

  return true;
}

export async function rehydratePendingEmails(): Promise<number> {
  if (!emailQueue) return 0;

  // Recover any rows stuck in 'processing' from an abrupt crash where sentAt is still null
  await db
    .update(emails)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(and(eq(emails.status, 'processing'), isNull(emails.sentAt)));

  const pendingRows = await db
    .select({
      id: emails.id,
      batchId: emails.batchId,
      userId: emails.userId,
      senderId: emails.senderId,
      scheduledAt: emails.scheduledAt,
      idempotencyKey: emails.idempotencyKey,
    })
    .from(emails)
    .where(
      and(
        inArray(emails.status, ['scheduled', 'delayed']),
        isNull(emails.sentAt)
      )
    );

  if (pendingRows.length === 0) return 0;

  const toRequeue: Array<{
    emailId: number;
    batchId: number;
    userId: number;
    senderId: number;
    scheduledAt: Date;
    idempotencyKey: string;
    delayBetweenMs: number;
    hourlyLimit: number;
  }> = [];

  for (const row of pendingRows) {
    const existingJob = await emailQueue.getJob(row.idempotencyKey);
    if (!existingJob) {
      toRequeue.push({
        emailId: row.id,
        batchId: row.batchId,
        userId: row.userId,
        senderId: row.senderId,
        scheduledAt: row.scheduledAt,
        idempotencyKey: row.idempotencyKey,
        delayBetweenMs: env.minDelayBetweenEmailsMs,
        hourlyLimit: env.maxEmailsPerHourPerSender,
      });
    }
  }

  if (toRequeue.length > 0) {
    await enqueueEmailJobs(toRequeue);
    console.log(`Rehydrated ${toRequeue.length} pending email job(s) into BullMQ.`);
  }

  return toRequeue.length;
}

export async function getQueueTelemetry(userId: number) {
  const redis = getRedisConnection();
  const status = getRedisStatus();
  const hourWindow = getHourWindowKey(new Date());

  const userSenders = await db
    .select({
      id: senders.id,
      name: senders.name,
      email: senders.email,
      hourlyLimit: senders.hourlyLimit,
    })
    .from(senders)
    .where(eq(senders.userId, userId));

  const hourStart = new Date();
  hourStart.setUTCMinutes(0, 0, 0);

  const senderUsage = await Promise.all(
    userSenders.map(async (sender) => {
      const limit = sender.hourlyLimit ?? env.maxEmailsPerHourPerSender;
      let sentThisHour = 0;
      if (redis && status.connected) {
        try {
          const val = await redis.get(`ratelimit:sender:${sender.id}:${hourWindow}`);
          sentThisHour = val ? Number.parseInt(val, 10) : 0;
        } catch {
          sentThisHour = 0;
        }
      } else {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(emails)
          .where(
            and(
              eq(emails.senderId, sender.id),
              eq(emails.status, 'sent'),
              gte(emails.sentAt, hourStart)
            )
          );
        sentThisHour = count;
      }
      return {
        senderId: sender.id,
        name: sender.name,
        email: sender.email,
        sentThisHour,
        hourlyLimit: limit,
        hourWindow,
      };
    })
  );

  let counts = {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    paused: 0,
  };

  if (emailQueue && status.connected) {
    try {
      const jobCounts = await emailQueue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed'
      );
      counts = {
        waiting: jobCounts.waiting ?? 0,
        active: jobCounts.active ?? 0,
        delayed: jobCounts.delayed ?? 0,
        completed: jobCounts.completed ?? 0,
        failed: jobCounts.failed ?? 0,
        paused: 0,
      };
    } catch {
      // keep zeroed counts if Redis disconnected mid-request
    }
  } else {
    const dbCounts = await db
      .select({
        status: emails.status,
        count: sql<number>`count(*)::int`,
      })
      .from(emails)
      .where(eq(emails.userId, userId))
      .groupBy(emails.status);

    for (const row of dbCounts) {
      if (row.status === 'scheduled') counts.waiting = row.count;
      else if (row.status === 'processing') counts.active = row.count;
      else if (row.status === 'delayed') counts.delayed = row.count;
      else if (row.status === 'sent') counts.completed = row.count;
      else if (row.status === 'failed') counts.failed = row.count;
    }
  }

  return {
    redis: status,
    workerConcurrency: env.workerConcurrency,
    minDelayBetweenEmailsMs: env.minDelayBetweenEmailsMs,
    maxEmailsPerHourPerSender: env.maxEmailsPerHourPerSender,
    hourWindow,
    counts,
    senderUsage,
  };
}

export function getBullBoardRouter(): Router | null {
  return queueRouter;
}
