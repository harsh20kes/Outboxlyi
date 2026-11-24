import crypto from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/index.ts';
import {
  emailBatches,
  emails,
  rateLimitLogs,
  senders,
  systemMailConfig,
  users,
} from '../../db/schema.ts';
import { env } from '../config/env.ts';
import { requireAuth } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  enqueueEmailJobs,
  getQueueTelemetry,
  rehydratePendingEmails,
} from '../queue/emailQueue.ts';
import { notifyPgDispatcher } from '../queue/pgFallbackDispatcher.ts';
import {
  getElasticsearchStatus,
  indexEmailDocuments,
  searchEmailsWithFallback,
} from '../services/elasticsearch.ts';
import {
  clearGmailToken,
  getGmailToken,
  setGmailToken,
} from '../services/gmailTokenStore.ts';
import {
  createEtherealTestAccount,
  getDeliveryMode,
  sendEmailViaSender,
  verifySmtpConnection,
} from '../services/mailer.ts';
import { getRedisStatus } from '../services/redis.ts';
import {
  buildSlackAuthorizeUrl,
  getSlackRedirectUri,
  isSlackConfigured,
  sendSlackMessageToUser,
} from '../services/slack.ts';
import { getSystemMailerStatus } from '../services/systemMailer.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const apiRouter = Router();

apiRouter.use(requireAuth);

// 1. Current user profile & Slack connection status (never expose secrets/tokens)
apiRouter.get('/me', (req: AuthRequest, res) => {
  const user = req.dbUser!;
  res.json({
    id: user.id,
    uid: user.uid,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    slack: {
      connected: Boolean(user.slackWebhookUrl || user.slackAccessToken),
      configuredOnServer: isSlackConfigured(),
      teamName: user.slackTeamName,
      channelName: user.slackChannelName,
      connectedAt: user.slackConnectedAt,
      redirectUri: getSlackRedirectUri(),
    },
  });
});

// 2. System integration status (Redis, Elasticsearch, Slack OAuth config, worker defaults)
apiRouter.get('/system/status', (_req: AuthRequest, res) => {
  res.json({
    redis: getRedisStatus(),
    elasticsearch: getElasticsearchStatus(),
    slackConfigured: isSlackConfigured(),
    defaults: {
      workerConcurrency: env.workerConcurrency,
      minDelayBetweenEmailsMs: env.minDelayBetweenEmailsMs,
      maxEmailsPerHourPerSender: env.maxEmailsPerHourPerSender,
    },
  });
});

// 2b. System verification mailer configuration (used to send real signup verification emails)
apiRouter.get('/system/mailer', async (_req: AuthRequest, res) => {
  try {
    const status = await getSystemMailerStatus();
    res.json(status);
  } catch (error) {
    console.error('Failed to get system mailer status:', error);
    res.status(500).json({ error: 'Failed to load system mailer settings.' });
  }
});

apiRouter.post('/system/mailer', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const senderIdRaw = Number.parseInt(String(req.body?.senderId ?? ''), 10);

  try {
    const existingConfig = await db
      .select({ updatedByUserId: systemMailConfig.updatedByUserId })
      .from(systemMailConfig)
      .where(eq(systemMailConfig.id, 1))
      .limit(1);

    const [{ minUserId }] = await db
      .select({ minUserId: sql<number>`COALESCE(MIN(${users.id}), 0)::int` })
      .from(users);

    if (
      existingConfig[0] &&
      existingConfig[0].updatedByUserId &&
      existingConfig[0].updatedByUserId !== userId &&
      minUserId !== userId
    ) {
      res.status(403).json({
        error: 'Only the workspace owner can modify the system verification mailer.',
      });
      return;
    }

    let fromName = typeof req.body?.fromName === 'string' ? req.body.fromName.trim() : 'Outboxly';
    let fromEmail = typeof req.body?.fromEmail === 'string' ? req.body.fromEmail.trim().toLowerCase() : '';
    let smtpHost = typeof req.body?.smtpHost === 'string' ? req.body.smtpHost.trim() : '';
    let smtpPort = Number.parseInt(String(req.body?.smtpPort ?? '465'), 10);
    let smtpUser = typeof req.body?.smtpUser === 'string' ? req.body.smtpUser.trim() : '';
    let smtpPass = typeof req.body?.smtpPass === 'string' ? req.body.smtpPass : '';

    if (Number.isFinite(senderIdRaw)) {
      const [senderRow] = await db
        .select()
        .from(senders)
        .where(and(eq(senders.id, senderIdRaw), eq(senders.userId, userId)))
        .limit(1);

      if (!senderRow) {
        res.status(404).json({ error: 'Selected sender not found.' });
        return;
      }
      if (getDeliveryMode(senderRow.smtpHost) !== 'smtp-live') {
        res.status(400).json({
          error:
            'Please choose a Live SMTP sender (such as Gmail App Password, Brevo, Resend, or SendGrid) for signup verification emails.',
        });
        return;
      }

      fromName = senderRow.name || 'Outboxly';
      fromEmail = senderRow.email;
      smtpHost = senderRow.smtpHost;
      smtpPort = senderRow.smtpPort;
      smtpUser = senderRow.smtpUser;
      smtpPass = senderRow.smtpPass;
    }

    if (!EMAIL_REGEX.test(fromEmail) || !smtpHost || !smtpUser || !smtpPass) {
      res.status(400).json({ error: 'All system SMTP fields are required.' });
      return;
    }

    const normalizedPort = Number.isFinite(smtpPort) && smtpPort > 0 ? smtpPort : 465;

    await verifySmtpConnection({
      id: 0,
      userId,
      name: fromName || 'Outboxly',
      email: fromEmail,
      smtpHost,
      smtpPort: normalizedPort,
      smtpUser,
      smtpPass,
    });

    await db
      .insert(systemMailConfig)
      .values({
        id: 1,
        provider: 'smtp',
        fromName: (fromName || 'Outboxly').slice(0, 80),
        fromEmail,
        smtpHost,
        smtpPort: normalizedPort,
        smtpUser,
        smtpPass,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemMailConfig.id,
        set: {
          provider: 'smtp',
          fromName: (fromName || 'Outboxly').slice(0, 80),
          fromEmail,
          smtpHost,
          smtpPort: normalizedPort,
          smtpUser,
          smtpPass,
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    const status = await getSystemMailerStatus();
    res.json(status);
  } catch (error) {
    console.error('Failed to configure system mailer:', error);
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to verify and save system mailer.',
    });
  }
});

apiRouter.delete('/system/mailer', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  try {
    const existingConfig = await db
      .select({ updatedByUserId: systemMailConfig.updatedByUserId })
      .from(systemMailConfig)
      .where(eq(systemMailConfig.id, 1))
      .limit(1);

    const [{ minUserId }] = await db
      .select({ minUserId: sql<number>`COALESCE(MIN(${users.id}), 0)::int` })
      .from(users);

    if (
      existingConfig[0] &&
      existingConfig[0].updatedByUserId &&
      existingConfig[0].updatedByUserId !== userId &&
      minUserId !== userId
    ) {
      res.status(403).json({
        error: 'Only the workspace owner can clear the system verification mailer.',
      });
      return;
    }

    await db.delete(systemMailConfig).where(eq(systemMailConfig.id, 1));
    const status = await getSystemMailerStatus();
    res.json(status);
  } catch (error) {
    console.error('Failed to clear system mailer:', error);
    res.status(500).json({ error: 'Failed to clear system mailer.' });
  }
});

type PublicSenderRow = {
  id: number;
  name: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  etherealWebUrl: string | null;
  hourlyLimit: number | null;
  isDefault: boolean;
  createdAt: Date;
};

function formatSenderDto(row: PublicSenderRow) {
  return {
    ...row,
    deliveryMode: getDeliveryMode(row.smtpHost),
  };
}

async function resolveGoogleGmailEmail(
  accessToken: string
): Promise<{ email: string; name: string | null }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error('Gmail authorization token is invalid or expired. Please reconnect Gmail.');
  }
  const data = (await res.json()) as { email?: string; name?: string };
  if (!data.email || !EMAIL_REGEX.test(data.email)) {
    throw new Error('Could not verify Gmail address from Google authorization.');
  }
  return {
    email: data.email.trim().toLowerCase(),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null,
  };
}

// 3. Senders CRUD & Gmail / SMTP / Ethereal provisioning
apiRouter.get('/senders', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  try {
    let rows = await db
      .select({
        id: senders.id,
        name: senders.name,
        email: senders.email,
        smtpHost: senders.smtpHost,
        smtpPort: senders.smtpPort,
        smtpUser: senders.smtpUser,
        etherealWebUrl: senders.etherealWebUrl,
        hourlyLimit: senders.hourlyLimit,
        isDefault: senders.isDefault,
        createdAt: senders.createdAt,
      })
      .from(senders)
      .where(eq(senders.userId, userId))
      .orderBy(desc(senders.isDefault), desc(senders.createdAt));

    if (rows.length === 0 && env.etherealAutoProvision) {
      try {
        const account = await createEtherealTestAccount();
        const [inserted] = await db
          .insert(senders)
          .values({
            userId,
            name: req.dbUser!.name || 'Ethereal Sandbox Sender',
            email: account.email,
            smtpHost: account.smtpHost,
            smtpPort: account.smtpPort,
            smtpUser: account.smtpUser,
            smtpPass: account.smtpPass,
            etherealWebUrl: account.etherealWebUrl,
            hourlyLimit: env.maxEmailsPerHourPerSender,
            isDefault: true,
          })
          .returning({
            id: senders.id,
            name: senders.name,
            email: senders.email,
            smtpHost: senders.smtpHost,
            smtpPort: senders.smtpPort,
            smtpUser: senders.smtpUser,
            etherealWebUrl: senders.etherealWebUrl,
            hourlyLimit: senders.hourlyLimit,
            isDefault: senders.isDefault,
            createdAt: senders.createdAt,
          });
        if (inserted) {
          rows = [inserted];
        }
      } catch (ethError) {
        console.warn('Auto-provisioning Ethereal sender failed:', ethError);
      }
    }

    res.json({ senders: rows.map(formatSenderDto) });
  } catch (error) {
    console.error('Failed to list senders:', error);
    res.status(500).json({ error: 'Failed to load sender accounts.' });
  }
});

apiRouter.post('/senders/gmail', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const gmailToken =
    typeof req.headers['x-gmail-access-token'] === 'string'
      ? req.headers['x-gmail-access-token'].trim()
      : '';

  if (!gmailToken) {
    res.status(400).json({ error: 'Missing Gmail OAuth access token.' });
    return;
  }

  try {
    const googleProfile = await resolveGoogleGmailEmail(gmailToken);
    setGmailToken(userId, gmailToken, googleProfile.email);

    const existingRows = await db
      .select()
      .from(senders)
      .where(eq(senders.userId, userId));

    const existingGmail = existingRows.find(
      (s) =>
        s.smtpHost === 'gmail-api' &&
        s.email.toLowerCase() === googleProfile.email
    );

    const hasLiveSender = existingRows.some(
      (s) => getDeliveryMode(s.smtpHost) !== 'ethereal-sandbox'
    );

    if (existingGmail) {
      if (!hasLiveSender || !existingGmail.isDefault) {
        // Ensure a live Gmail sender becomes default if only Ethereal was default
        const currentDefault = existingRows.find((s) => s.isDefault);
        if (
          !currentDefault ||
          getDeliveryMode(currentDefault.smtpHost) === 'ethereal-sandbox'
        ) {
          await db
            .update(senders)
            .set({ isDefault: false })
            .where(eq(senders.userId, userId));
          await db
            .update(senders)
            .set({ isDefault: true })
            .where(eq(senders.id, existingGmail.id));
          existingGmail.isDefault = true;
        }
      }

      res.json({
        sender: formatSenderDto(existingGmail),
        gmailConnected: true,
        gmailEmail: googleProfile.email,
      });
      return;
    }

    const shouldBeDefault =
      existingRows.length === 0 ||
      existingRows.every(
        (s) => getDeliveryMode(s.smtpHost) === 'ethereal-sandbox'
      );

    if (shouldBeDefault && existingRows.length > 0) {
      await db
        .update(senders)
        .set({ isDefault: false })
        .where(eq(senders.userId, userId));
    }

    const senderName =
      (typeof req.body?.name === 'string' && req.body.name.trim()) ||
      googleProfile.name ||
      req.dbUser!.name ||
      'Gmail Sender';

    const [created] = await db
      .insert(senders)
      .values({
        userId,
        name: senderName.slice(0, 80),
        email: googleProfile.email,
        smtpHost: 'gmail-api',
        smtpPort: 443,
        smtpUser: googleProfile.email,
        smtpPass: 'oauth-in-memory',
        etherealWebUrl: null,
        hourlyLimit: Math.min(100, env.maxEmailsPerHourPerSender),
        isDefault: shouldBeDefault,
      })
      .returning({
        id: senders.id,
        name: senders.name,
        email: senders.email,
        smtpHost: senders.smtpHost,
        smtpPort: senders.smtpPort,
        smtpUser: senders.smtpUser,
        etherealWebUrl: senders.etherealWebUrl,
        hourlyLimit: senders.hourlyLimit,
        isDefault: senders.isDefault,
        createdAt: senders.createdAt,
      });

    res.status(201).json({
      sender: formatSenderDto(created),
      gmailConnected: true,
      gmailEmail: googleProfile.email,
    });
  } catch (error) {
    console.error('Failed to connect Gmail sender:', error);
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : 'Unable to authorize Gmail sender.',
    });
  }
});

apiRouter.post('/gmail/token', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const gmailToken =
    typeof req.headers['x-gmail-access-token'] === 'string'
      ? req.headers['x-gmail-access-token'].trim()
      : '';

  if (!gmailToken) {
    res.status(400).json({ error: 'Missing Gmail OAuth access token.' });
    return;
  }

  try {
    const googleProfile = await resolveGoogleGmailEmail(gmailToken);
    setGmailToken(userId, gmailToken, googleProfile.email);
    res.json({ connected: true, gmailEmail: googleProfile.email });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : 'Invalid Gmail access token.',
    });
  }
});

apiRouter.get('/gmail/status', (req: AuthRequest, res) => {
  const entry = getGmailToken(req.dbUser!.id);
  res.json({
    connected: Boolean(entry),
    gmailEmail: entry?.gmailEmail ?? null,
  });
});

apiRouter.post('/gmail/disconnect', (req: AuthRequest, res) => {
  clearGmailToken(req.dbUser!.id);
  res.json({ disconnected: true });
});

apiRouter.post('/senders/ethereal', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const customName =
    typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim().slice(0, 80)
      : `Ethereal Sandbox ${new Date().toISOString().slice(11, 19)}`;
  const hourlyLimitRaw = Number.parseInt(String(req.body?.hourlyLimit ?? ''), 10);
  const hourlyLimit =
    Number.isFinite(hourlyLimitRaw) && hourlyLimitRaw > 0
      ? Math.min(hourlyLimitRaw, env.maxEmailsPerHourPerSender)
      : env.maxEmailsPerHourPerSender;

  try {
    const account = await createEtherealTestAccount();
    const existing = await db
      .select({ id: senders.id })
      .from(senders)
      .where(eq(senders.userId, userId))
      .limit(1);

    const [created] = await db
      .insert(senders)
      .values({
        userId,
        name: customName,
        email: account.email,
        smtpHost: account.smtpHost,
        smtpPort: account.smtpPort,
        smtpUser: account.smtpUser,
        smtpPass: account.smtpPass,
        etherealWebUrl: account.etherealWebUrl,
        hourlyLimit,
        isDefault: existing.length === 0,
      })
      .returning({
        id: senders.id,
        name: senders.name,
        email: senders.email,
        smtpHost: senders.smtpHost,
        smtpPort: senders.smtpPort,
        smtpUser: senders.smtpUser,
        etherealWebUrl: senders.etherealWebUrl,
        hourlyLimit: senders.hourlyLimit,
        isDefault: senders.isDefault,
        createdAt: senders.createdAt,
      });

    res.status(201).json({ sender: formatSenderDto(created) });
  } catch (error) {
    console.error('Failed to provision Ethereal account:', error);
    res.status(502).json({
      error: 'Could not provision a new Ethereal test account. Try again or add credentials manually.',
    });
  }
});

apiRouter.post('/senders', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const smtpHost = typeof req.body?.smtpHost === 'string' ? req.body.smtpHost.trim() : '';
  const smtpPort = Number.parseInt(String(req.body?.smtpPort ?? '587'), 10);
  const smtpUser = typeof req.body?.smtpUser === 'string' ? req.body.smtpUser.trim() : '';
  const smtpPass = typeof req.body?.smtpPass === 'string' ? req.body.smtpPass : '';
  const hourlyLimitRaw = Number.parseInt(String(req.body?.hourlyLimit ?? ''), 10);
  const hourlyLimit =
    Number.isFinite(hourlyLimitRaw) && hourlyLimitRaw > 0
      ? Math.min(hourlyLimitRaw, env.maxEmailsPerHourPerSender)
      : env.maxEmailsPerHourPerSender;

  if (!name || !EMAIL_REGEX.test(email) || !smtpHost || !smtpUser || !smtpPass) {
    res.status(400).json({ error: 'All sender SMTP fields and a valid email are required.' });
    return;
  }

  const normalizedPort = Number.isFinite(smtpPort) && smtpPort > 0 ? smtpPort : 587;

  try {
    await verifySmtpConnection({
      id: 0,
      userId,
      name: name.slice(0, 80),
      email,
      smtpHost,
      smtpPort: normalizedPort,
      smtpUser,
      smtpPass,
    });
  } catch (verifyError) {
    res.status(400).json({
      error:
        verifyError instanceof Error
          ? verifyError.message
          : 'Could not verify SMTP credentials.',
    });
    return;
  }

  try {
    const existing = await db
      .select({ id: senders.id, smtpHost: senders.smtpHost })
      .from(senders)
      .where(eq(senders.userId, userId));

    const isLive = getDeliveryMode(smtpHost) !== 'ethereal-sandbox';
    const shouldBeDefault =
      existing.length === 0 ||
      (isLive &&
        existing.every(
          (s) => getDeliveryMode(s.smtpHost) === 'ethereal-sandbox'
        ));

    if (shouldBeDefault && existing.length > 0) {
      await db
        .update(senders)
        .set({ isDefault: false })
        .where(eq(senders.userId, userId));
    }

    const [created] = await db
      .insert(senders)
      .values({
        userId,
        name: name.slice(0, 80),
        email,
        smtpHost,
        smtpPort: normalizedPort,
        smtpUser,
        smtpPass,
        etherealWebUrl: smtpHost.includes('ethereal.email') ? 'https://ethereal.email' : null,
        hourlyLimit,
        isDefault: shouldBeDefault,
      })
      .returning({
        id: senders.id,
        name: senders.name,
        email: senders.email,
        smtpHost: senders.smtpHost,
        smtpPort: senders.smtpPort,
        smtpUser: senders.smtpUser,
        etherealWebUrl: senders.etherealWebUrl,
        hourlyLimit: senders.hourlyLimit,
        isDefault: senders.isDefault,
        createdAt: senders.createdAt,
      });

    res.status(201).json({ sender: formatSenderDto(created) });
  } catch (error) {
    console.error('Failed to add sender:', error);
    res.status(500).json({ error: 'Failed to create sender account.' });
  }
});

apiRouter.post('/senders/:id/test', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const senderId = Number.parseInt(req.params.id, 10);
  const to = typeof req.body?.to === 'string' ? req.body.to.trim().toLowerCase() : '';
  const subject =
    typeof req.body?.subject === 'string' && req.body.subject.trim()
      ? req.body.subject.trim().slice(0, 200)
      : 'Outboxly Live Delivery Test';
  const body =
    typeof req.body?.body === 'string' && req.body.body.trim()
      ? req.body.body.trim()
      : 'This is a verification email sent from Outboxly to confirm real inbox delivery.';

  if (!Number.isFinite(senderId)) {
    res.status(400).json({ error: 'Invalid sender ID.' });
    return;
  }
  if (!EMAIL_REGEX.test(to)) {
    res.status(400).json({ error: 'Please enter a valid recipient email address.' });
    return;
  }

  const gmailTokenHeader =
    typeof req.headers['x-gmail-access-token'] === 'string'
      ? req.headers['x-gmail-access-token'].trim()
      : '';
  if (gmailTokenHeader) {
    setGmailToken(userId, gmailTokenHeader);
  }

  try {
    const [senderRow] = await db
      .select()
      .from(senders)
      .where(and(eq(senders.id, senderId), eq(senders.userId, userId)))
      .limit(1);

    if (!senderRow) {
      res.status(404).json({ error: 'Sender account not found.' });
      return;
    }

    const result = await sendEmailViaSender({
      sender: senderRow,
      to,
      subject,
      body,
      gmailAccessToken: gmailTokenHeader || undefined,
    });

    res.json({
      sent: true,
      messageId: result.messageId,
      previewUrl: result.previewUrl,
      deliveryMode: getDeliveryMode(senderRow.smtpHost),
    });
  } catch (error) {
    console.error('Test email failed:', error);
    res.status(400).json({
      error:
        error instanceof Error ? error.message : 'Test email delivery failed.',
    });
  }
});

apiRouter.delete('/senders/:id', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const senderId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(senderId)) {
    res.status(400).json({ error: 'Invalid sender ID' });
    return;
  }

  try {
    const deleted = await db
      .delete(senders)
      .where(and(eq(senders.id, senderId), eq(senders.userId, userId)))
      .returning({ id: senders.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: 'Sender not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (error) {
    console.error('Failed to delete sender:', error);
    res.status(500).json({ error: 'Failed to delete sender account.' });
  }
});

// 4. Schedule new email batch
apiRouter.post('/emails/schedule', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const senderId = Number.parseInt(String(req.body?.senderId ?? ''), 10);
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const rawRecipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  const startTimeRaw = typeof req.body?.startTime === 'string' ? req.body.startTime : '';
  const delaySeconds = Number(req.body?.delaySeconds ?? 2);
  const hourlyLimitRaw = Number.parseInt(String(req.body?.hourlyLimit ?? ''), 10);
  const clientBatchKey =
    typeof req.body?.batchKey === 'string' && req.body.batchKey.trim()
      ? req.body.batchKey.trim()
      : crypto.randomUUID();

  if (!Number.isFinite(senderId)) {
    res.status(400).json({ error: 'Please select a valid sender account.' });
    return;
  }
  if (!subject || !body) {
    res.status(400).json({ error: 'Subject and email body are required.' });
    return;
  }

  // Validate and deduplicate recipients
  const seen = new Set<string>();
  const validRecipients: string[] = [];
  for (const item of rawRecipients) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (EMAIL_REGEX.test(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      validRecipients.push(normalized);
    }
  }

  if (validRecipients.length === 0) {
    res.status(400).json({ error: 'At least one valid recipient email address is required.' });
    return;
  }
  if (validRecipients.length > 10000) {
    res.status(400).json({ error: 'Maximum 10,000 recipients per batch.' });
    return;
  }

  const parsedStart = startTimeRaw ? new Date(startTimeRaw) : new Date();
  if (Number.isNaN(parsedStart.getTime())) {
    res.status(400).json({ error: 'Invalid start time format.' });
    return;
  }

  const delayBetweenMs = Math.max(
    Number.isFinite(delaySeconds) && delaySeconds >= 0 ? Math.round(delaySeconds * 1000) : env.minDelayBetweenEmailsMs,
    env.minDelayBetweenEmailsMs
  );

  const hourlyLimit =
    Number.isFinite(hourlyLimitRaw) && hourlyLimitRaw > 0
      ? Math.min(hourlyLimitRaw, env.maxEmailsPerHourPerSender)
      : env.maxEmailsPerHourPerSender;

  try {
    const [senderRow] = await db
      .select()
      .from(senders)
      .where(and(eq(senders.id, senderId), eq(senders.userId, userId)))
      .limit(1);

    if (!senderRow) {
      res.status(404).json({ error: 'Selected sender account not found.' });
      return;
    }

    const gmailTokenHeader =
      typeof req.headers['x-gmail-access-token'] === 'string'
        ? req.headers['x-gmail-access-token'].trim()
        : '';
    if (gmailTokenHeader) {
      setGmailToken(userId, gmailTokenHeader, senderRow.email);
    }

    const deliveryMode = getDeliveryMode(senderRow.smtpHost);
    if (deliveryMode === 'gmail-api' && !getGmailToken(userId)) {
      res.status(400).json({
        error:
          'Gmail send authorization is missing or expired. Click "Reconnect Gmail" before scheduling.',
      });
      return;
    }

    const [batch] = await db
      .insert(emailBatches)
      .values({
        userId,
        senderId: senderRow.id,
        subject: subject.slice(0, 300),
        body,
        totalRecipients: validRecipients.length,
        startTime: parsedStart,
        delayBetweenMs,
        hourlyLimit,
      })
      .returning();

    const baseStartMs = Math.max(parsedStart.getTime(), Date.now());
    const effectiveLimit = Math.min(
      hourlyLimit,
      senderRow.hourlyLimit ?? env.maxEmailsPerHourPerSender
    );

    const rowsToInsert = validRecipients.map((recipient, idx) => {
      // Stagger initial scheduled time by index * delayBetweenMs
      const scheduledAt = new Date(baseStartMs + idx * delayBetweenMs);
      const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${userId}:${senderRow.id}:${clientBatchKey}:${recipient}`)
        .digest('hex')
        .slice(0, 32);

      return {
        batchId: batch.id,
        userId,
        senderId: senderRow.id,
        recipientEmail: recipient,
        subject: subject.slice(0, 300),
        body,
        status: 'scheduled',
        scheduledAt,
        idempotencyKey,
        bullJobId: idempotencyKey,
      };
    });

    const insertedEmails: Array<typeof emails.$inferSelect> = [];
    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const inserted = await db
        .insert(emails)
        .values(chunk)
        .onConflictDoNothing({ target: emails.idempotencyKey })
        .returning();
      insertedEmails.push(...inserted);
    }

    const queuedInBullMQ = await enqueueEmailJobs(
      insertedEmails.map((em) => ({
        emailId: em.id,
        batchId: em.batchId,
        userId: em.userId,
        senderId: em.senderId,
        scheduledAt: em.scheduledAt,
        idempotencyKey: em.idempotencyKey,
        delayBetweenMs,
        hourlyLimit: effectiveLimit,
      }))
    );

    await indexEmailDocuments(
      insertedEmails.map((em) => ({
        id: em.id,
        batchId: em.batchId,
        userId: em.userId,
        senderId: em.senderId,
        senderEmail: senderRow.email,
        recipientEmail: em.recipientEmail,
        subject: em.subject,
        body: em.body,
        status: em.status,
        scheduledAt: em.scheduledAt.toISOString(),
        sentAt: null,
        etherealPreviewUrl: null,
        errorMessage: null,
      }))
    );

    if (!queuedInBullMQ) {
      await notifyPgDispatcher();
    }

    let scheduleWarning: string | null = null;
    if (deliveryMode === 'ethereal-sandbox') {
      scheduleWarning =
        'Scheduled using Ethereal sandbox — messages are captured at ethereal.email and will not reach real recipient inboxes.';
    } else if (
      deliveryMode === 'gmail-api' &&
      baseStartMs - Date.now() > 45 * 60 * 1000
    ) {
      scheduleWarning =
        'Gmail OAuth sessions expire after ~50 minutes. For batches scheduled further in the future, configure a Gmail App Password SMTP sender in Integrations.';
    }

    res.status(201).json({
      batchId: batch.id,
      scheduledCount: insertedEmails.length,
      queuedInBullMQ,
      warning: scheduleWarning,
    });
  } catch (error) {
    console.error('Failed to schedule email batch:', error);
    res.status(500).json({ error: 'Failed to schedule email batch.' });
  }
});

// 5. List emails (Scheduled or Sent tabs) with pagination & filtering
apiRouter.get('/emails', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const tab = req.query.tab === 'sent' ? 'sent' : 'scheduled';
  const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const senderIdRaw = Number.parseInt(String(req.query.senderId ?? ''), 10);
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));

  try {
    const allowedStatuses =
      tab === 'sent' ? ['sent', 'failed'] : ['scheduled', 'delayed', 'processing'];
    const conditions = [eq(emails.userId, userId)];

    if (statusFilter && allowedStatuses.includes(statusFilter)) {
      conditions.push(eq(emails.status, statusFilter));
    } else {
      conditions.push(inArray(emails.status, allowedStatuses));
    }

    if (Number.isFinite(senderIdRaw)) {
      conditions.push(eq(emails.senderId, senderIdRaw));
    }

    if (search.length > 0) {
      const pattern = `%${search}%`;
      const cond = or(
        ilike(emails.recipientEmail, pattern),
        ilike(emails.subject, pattern),
        ilike(emails.body, pattern),
        ilike(senders.email, pattern)
      );
      if (cond) conditions.push(cond);
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .innerJoin(senders, eq(emails.senderId, senders.id))
      .where(and(...conditions));

    const rows = await db
      .select({
        id: emails.id,
        batchId: emails.batchId,
        senderId: emails.senderId,
        senderName: senders.name,
        senderEmail: senders.email,
        recipientEmail: emails.recipientEmail,
        subject: emails.subject,
        body: emails.body,
        status: emails.status,
        scheduledAt: emails.scheduledAt,
        sentAt: emails.sentAt,
        etherealPreviewUrl: emails.etherealPreviewUrl,
        errorMessage: emails.errorMessage,
        retryCount: emails.retryCount,
        createdAt: emails.createdAt,
      })
      .from(emails)
      .innerJoin(senders, eq(emails.senderId, senders.id))
      .where(and(...conditions))
      .orderBy(tab === 'sent' ? desc(emails.sentAt) : desc(emails.scheduledAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      items: rows,
      total: count,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(500).json({ error: 'Failed to load emails.' });
  }
});

// 6. Elasticsearch search endpoint
apiRouter.get('/emails/search', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const tab =
    req.query.tab === 'scheduled' || req.query.tab === 'sent'
      ? req.query.tab
      : 'all';

  try {
    const result = await searchEmailsWithFallback({
      userId,
      query,
      tab,
      limit: 50,
    });
    res.json(result);
  } catch (error) {
    console.error('Email search error:', error);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// 7. Live BullMQ queue telemetry & rate-limit logs
apiRouter.get('/queues/stats', async (req: AuthRequest, res) => {
  const userId = req.dbUser!.id;
  try {
    const telemetry = await getQueueTelemetry(userId);
    const logs = await db
      .select({
        id: rateLimitLogs.id,
        senderId: rateLimitLogs.senderId,
        senderEmail: senders.email,
        senderName: senders.name,
        hourWindow: rateLimitLogs.hourWindow,
        limitValue: rateLimitLogs.limitValue,
        slackNotified: rateLimitLogs.slackNotified,
        createdAt: rateLimitLogs.createdAt,
      })
      .from(rateLimitLogs)
      .innerJoin(senders, eq(rateLimitLogs.senderId, senders.id))
      .where(eq(rateLimitLogs.userId, userId))
      .orderBy(desc(rateLimitLogs.createdAt))
      .limit(20);

    const statusSummary = await db
      .select({
        status: emails.status,
        count: sql<number>`count(*)::int`,
      })
      .from(emails)
      .where(eq(emails.userId, userId))
      .groupBy(emails.status);

    res.json({
      ...telemetry,
      rateLimitLogs: logs,
      emailStatusCounts: statusSummary,
    });
  } catch (error) {
    console.error('Failed to get queue stats:', error);
    res.status(500).json({ error: 'Failed to load queue metrics.' });
  }
});

apiRouter.post('/queues/rehydrate', async (_req: AuthRequest, res) => {
  try {
    const count = await rehydratePendingEmails();
    res.json({ rehydratedCount: count });
  } catch (error) {
    console.error('Rehydrate error:', error);
    res.status(500).json({ error: 'Failed to rehydrate pending jobs.' });
  }
});

// 8. Slack OAuth endpoints
apiRouter.get('/slack/auth-url', (req: AuthRequest, res) => {
  if (!isSlackConfigured()) {
    res.status(400).json({
      error: 'Slack OAuth is not configured on the server. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
      redirectUri: getSlackRedirectUri(),
    });
    return;
  }

  const url = buildSlackAuthorizeUrl(req.dbUser!.id);
  res.json({ url });
});

apiRouter.post('/slack/test', async (req: AuthRequest, res) => {
  const user = req.dbUser!;
  if (!user.slackWebhookUrl && !user.slackAccessToken) {
    res.status(400).json({ error: 'Slack is not connected for this account.' });
    return;
  }

  const ok = await sendSlackMessageToUser(
    user.id,
    `*Outboxly Test Alert*\nSlack rate-limit notifications are active for *${user.email}*.`
  );

  if (!ok) {
    res.status(502).json({ error: 'Failed to deliver Slack test message.' });
    return;
  }

  res.json({ sent: true });
});

apiRouter.post('/slack/disconnect', async (req: AuthRequest, res) => {
  try {
    await db
      .update(users)
      .set({
        slackTeamId: null,
        slackTeamName: null,
        slackChannelName: null,
        slackChannelId: null,
        slackWebhookUrl: null,
        slackAccessToken: null,
        slackConnectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.dbUser!.id));

    res.json({ disconnected: true });
  } catch (error) {
    console.error('Slack disconnect failed:', error);
    res.status(500).json({ error: 'Failed to disconnect Slack.' });
  }
});
