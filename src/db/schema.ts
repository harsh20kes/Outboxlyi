import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  emailVerified: boolean('email_verified').default(true).notNull(),
  slackTeamId: text('slack_team_id'),
  slackTeamName: text('slack_team_name'),
  slackChannelName: text('slack_channel_name'),
  slackChannelId: text('slack_channel_id'),
  slackWebhookUrl: text('slack_webhook_url'),
  slackAccessToken: text('slack_access_token'),
  slackConnectedAt: timestamp('slack_connected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const pendingSignups = pgTable('pending_signups', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  codeHash: text('code_hash').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  attempts: integer('attempts').default(0).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  lastSentAt: timestamp('last_sent_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const systemMailConfig = pgTable('system_mail_config', {
  id: integer('id').primaryKey(),
  provider: text('provider').notNull(),
  fromName: text('from_name').notNull(),
  fromEmail: text('from_email').notNull(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpUser: text('smtp_user').notNull(),
  smtpPass: text('smtp_pass').notNull(),
  updatedByUserId: integer('updated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const senders = pgTable(
  'senders',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    smtpUser: text('smtp_user').notNull(),
    smtpPass: text('smtp_pass').notNull(),
    etherealWebUrl: text('ethereal_web_url'),
    hourlyLimit: integer('hourly_limit'),
    isDefault: boolean('is_default').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('senders_user_id_idx').on(table.userId)]
);

export const emailBatches = pgTable(
  'email_batches',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    senderId: integer('sender_id')
      .references(() => senders.id, { onDelete: 'cascade' })
      .notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    totalRecipients: integer('total_recipients').notNull(),
    startTime: timestamp('start_time').notNull(),
    delayBetweenMs: integer('delay_between_ms').notNull(),
    hourlyLimit: integer('hourly_limit').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('email_batches_user_id_idx').on(table.userId)]
);

export const emails = pgTable(
  'emails',
  {
    id: serial('id').primaryKey(),
    batchId: integer('batch_id')
      .references(() => emailBatches.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    senderId: integer('sender_id')
      .references(() => senders.id, { onDelete: 'cascade' })
      .notNull(),
    recipientEmail: text('recipient_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull(), // 'scheduled' | 'delayed' | 'processing' | 'sent' | 'failed'
    scheduledAt: timestamp('scheduled_at').notNull(),
    sentAt: timestamp('sent_at'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    bullJobId: text('bull_job_id'),
    etherealPreviewUrl: text('ethereal_preview_url'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('emails_user_status_idx').on(table.userId, table.status),
    index('emails_scheduled_at_idx').on(table.scheduledAt),
    index('emails_sender_id_idx').on(table.senderId),
  ]
);

export const rateLimitLogs = pgTable(
  'rate_limit_logs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    senderId: integer('sender_id')
      .references(() => senders.id, { onDelete: 'cascade' })
      .notNull(),
    hourWindow: text('hour_window').notNull(),
    limitValue: integer('limit_value').notNull(),
    slackNotified: boolean('slack_notified').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('rate_limit_logs_user_id_idx').on(table.userId)]
);

export const usersRelations = relations(users, ({ many }) => ({
  senders: many(senders),
  batches: many(emailBatches),
  emails: many(emails),
  rateLimitLogs: many(rateLimitLogs),
}));

export const sendersRelations = relations(senders, ({ one, many }) => ({
  user: one(users, {
    fields: [senders.userId],
    references: [users.id],
  }),
  batches: many(emailBatches),
  emails: many(emails),
}));

export const emailBatchesRelations = relations(emailBatches, ({ one, many }) => ({
  user: one(users, {
    fields: [emailBatches.userId],
    references: [users.id],
  }),
  sender: one(senders, {
    fields: [emailBatches.senderId],
    references: [senders.id],
  }),
  emails: many(emails),
}));

export const emailsRelations = relations(emails, ({ one }) => ({
  batch: one(emailBatches, {
    fields: [emails.batchId],
    references: [emailBatches.id],
  }),
  user: one(users, {
    fields: [emails.userId],
    references: [users.id],
  }),
  sender: one(senders, {
    fields: [emails.senderId],
    references: [senders.id],
  }),
}));

export const rateLimitLogsRelations = relations(rateLimitLogs, ({ one }) => ({
  user: one(users, {
    fields: [rateLimitLogs.userId],
    references: [users.id],
  }),
  sender: one(senders, {
    fields: [rateLimitLogs.senderId],
    references: [senders.id],
  }),
}));
