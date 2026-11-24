import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

let sharedConnection: Redis | null = null;
let redisReady = false;
let redisConfigured = Boolean(env.redisUrl || env.redisHost);
let lastRedisError: string | null = null;
let initialized = false;

function buildRedisClient(enableAutoReconnect: boolean): Redis {
  const commonOptions = {
    maxRetriesPerRequest: null as null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 1500,
    retryStrategy: enableAutoReconnect
      ? (times: number) => Math.min(times * 500, 10000)
      : () => null,
  };

  if (env.redisUrl) {
    return new Redis(env.redisUrl, commonOptions);
  }
  return new Redis({
    host: env.redisHost || '127.0.0.1',
    port: env.redisPort,
    ...commonOptions,
  });
}

export async function initRedisConnection(): Promise<Redis | null> {
  if (initialized) {
    return sharedConnection;
  }
  initialized = true;

  // Always probe once before instantiating BullMQ Queue/Worker to prevent ECONNREFUSED retry storms
  const probe = buildRedisClient(false);
  probe.on('error', () => {
    // Handled via try/catch below
  });

  try {
    await probe.connect();
    await probe.ping();
    probe.disconnect();
  } catch (err) {
    probe.disconnect();
    sharedConnection = null;
    redisReady = false;
    lastRedisError =
      err instanceof Error ? err.message : 'Redis server unreachable';
    console.log(
      `Redis unavailable (${lastRedisError}); running with PostgreSQL persistent scheduler.`
    );
    return null;
  }

  redisConfigured = true;
  const client = buildRedisClient(true);
  client.on('ready', () => {
    redisReady = true;
    lastRedisError = null;
    console.log('Redis connection ready.');
  });
  client.on('close', () => {
    redisReady = false;
  });
  client.on('error', (err) => {
    redisReady = false;
    lastRedisError = err.message;
  });

  try {
    await client.connect();
    sharedConnection = client;
    redisReady = true;
    return client;
  } catch (err) {
    client.disconnect();
    sharedConnection = null;
    redisReady = false;
    lastRedisError =
      err instanceof Error ? err.message : 'Redis connection failed';
    return null;
  }
}

export function getRedisConnection(): Redis | null {
  return sharedConnection;
}

export function getRedisStatus() {
  return {
    configured: redisConfigured,
    connected: redisReady,
    lastError: lastRedisError,
  };
}
