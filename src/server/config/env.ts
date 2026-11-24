import crypto from 'node:crypto';
import * as dotenv from 'dotenv';

dotenv.config();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fallbackSlackStateSecret = crypto.randomBytes(32).toString('hex');
const fallbackSessionSecret = crypto.randomBytes(32).toString('hex');

export const env = {
  port: parsePositiveInt(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  redisUrl: process.env.REDIS_URL?.trim() || '',
  redisHost: process.env.REDIS_HOST?.trim() || '',
  redisPort: parsePositiveInt(process.env.REDIS_PORT, 6379),
  elasticsearchUrl: process.env.ELASTICSEARCH_URL?.trim() || '',
  elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY?.trim() || '',
  slackClientId: process.env.SLACK_CLIENT_ID?.trim() || '',
  slackClientSecret: process.env.SLACK_CLIENT_SECRET?.trim() || '',
  slackStateSecret: process.env.SLACK_STATE_SECRET?.trim() || fallbackSlackStateSecret,
  sessionSecret: process.env.SESSION_SECRET?.trim() || fallbackSessionSecret,
  workerConcurrency: parsePositiveInt(process.env.WORKER_CONCURRENCY, 5),
  minDelayBetweenEmailsMs: parsePositiveInt(process.env.MIN_DELAY_BETWEEN_EMAILS_MS, 2000),
  maxEmailsPerHourPerSender: parsePositiveInt(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER, 200),
  etherealAutoProvision: process.env.ETHEREAL_AUTO_PROVISION !== 'false',
  systemSmtpHost: process.env.SYSTEM_SMTP_HOST?.trim() || '',
  systemSmtpPort: parsePositiveInt(process.env.SYSTEM_SMTP_PORT, 465),
  systemSmtpUser: process.env.SYSTEM_SMTP_USER?.trim() || '',
  systemSmtpPass: process.env.SYSTEM_SMTP_PASS || '',
  systemFromName: process.env.SYSTEM_FROM_NAME?.trim() || 'Outboxly',
  systemFromEmail: process.env.SYSTEM_FROM_EMAIL?.trim() || '',
  resendApiKey: process.env.RESEND_API_KEY?.trim() || '',
};
