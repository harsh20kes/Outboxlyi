import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
  var _pgliteClient: PGlite | undefined;
  var _pgliteInitPromise: Promise<void> | undefined;
}

function isCloudSqlSocketAvailable(): boolean {
  const sqlHost = process.env.SQL_HOST?.trim() || '';
  if (!sqlHost) return false;
  if (sqlHost.startsWith('/')) {
    return fs.existsSync(path.join(sqlHost, '.s.PGSQL.5432'));
  }
  return true;
}

const databaseUrl = process.env.DATABASE_URL?.trim() || '';
const useCloudSqlPool = Boolean(databaseUrl) || isCloudSqlSocketAvailable();

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = databaseUrl
      ? new Pool({
          connectionString: databaseUrl,
          max: 10,
          connectionTimeoutMillis: 15000,
        })
      : new Pool({
          host: process.env.SQL_HOST,
          user: process.env.SQL_USER,
          password: process.env.SQL_PASSWORD,
          database: process.env.SQL_DB_NAME,
          max: 10,
          connectionTimeoutMillis: 15000,
        });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

function getOrCreatePglite(): PGlite {
  if (!global._pgliteClient) {
    const dataDir = path.resolve(process.cwd(), '.outboxly-data/pgdata');
    fs.mkdirSync(dataDir, { recursive: true });
    global._pgliteClient = new PGlite(dataDir);
  }
  return global._pgliteClient;
}

const LOCAL_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  slack_team_id TEXT,
  slack_team_name TEXT,
  slack_channel_name TEXT,
  slack_channel_id TEXT,
  slack_webhook_url TEXT,
  slack_access_token TEXT,
  slack_connected_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS pending_signups (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  last_sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_mail_config (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_user TEXT NOT NULL,
  smtp_pass TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS senders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_user TEXT NOT NULL,
  smtp_pass TEXT NOT NULL,
  ethereal_web_url TEXT,
  hourly_limit INTEGER,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS senders_user_id_idx ON senders(user_id);

CREATE TABLE IF NOT EXISTS email_batches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  total_recipients INTEGER NOT NULL,
  start_time TIMESTAMP NOT NULL,
  delay_between_ms INTEGER NOT NULL,
  hourly_limit INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_batches_user_id_idx ON email_batches(user_id);

CREATE TABLE IF NOT EXISTS emails (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES email_batches(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at TIMESTAMP NOT NULL,
  sent_at TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE,
  bull_job_id TEXT,
  ethereal_preview_url TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emails_user_status_idx ON emails(user_id, status);
CREATE INDEX IF NOT EXISTS emails_scheduled_at_idx ON emails(scheduled_at);
CREATE INDEX IF NOT EXISTS emails_sender_id_idx ON emails(sender_id);

CREATE TABLE IF NOT EXISTS rate_limit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  hour_window TEXT NOT NULL,
  limit_value INTEGER NOT NULL,
  slack_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rate_limit_logs_user_id_idx ON rate_limit_logs(user_id);
`;

export async function initDatabase(): Promise<void> {
  if (useCloudSqlPool) {
    return;
  }

  if (!global._pgliteInitPromise) {
    const client = getOrCreatePglite();
    global._pgliteInitPromise = (async () => {
      await client.waitReady;
      await client.exec(LOCAL_SCHEMA_DDL);
      console.log('Initialized persistent local PostgreSQL storage (.outboxly-data/pgdata).');
    })();
  }

  await global._pgliteInitPromise;
}

export const db: NodePgDatabase<typeof schema> = useCloudSqlPool
  ? drizzle(createPool(), { schema })
  : (drizzlePglite(getOrCreatePglite(), {
      schema,
    }) as unknown as NodePgDatabase<typeof schema>);
