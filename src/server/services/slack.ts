import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { users } from '../../db/schema.ts';
import { env } from '../config/env.ts';

interface SlackStatePayload {
  userId: number;
  nonce: string;
  exp: number;
}

export function getSlackRedirectUri(): string {
  return `${env.appUrl}/api/slack/callback`;
}

export function isSlackConfigured(): boolean {
  return Boolean(env.slackClientId && env.slackClientSecret);
}

export function createSlackOAuthState(userId: number): string {
  const payload: SlackStatePayload = {
    userId,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + 10 * 60 * 1000, // 10 min validity
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', env.slackStateSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySlackOAuthState(state: string): SlackStatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', env.slackStateSecret)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as SlackStatePayload;
    if (
      typeof parsed.userId !== 'number' ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildSlackAuthorizeUrl(userId: number): string {
  const state = createSlackOAuthState(userId);
  const params = new URLSearchParams({
    client_id: env.slackClientId,
    scope: 'incoming-webhook,chat:write',
    redirect_uri: getSlackRedirectUri(),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(code: string) {
  const body = new URLSearchParams({
    client_id: env.slackClientId,
    client_secret: env.slackClientSecret,
    code,
    redirect_uri: getSlackRedirectUri(),
  });

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    team?: { id?: string; name?: string };
    incoming_webhook?: {
      url?: string;
      channel?: string;
      channel_id?: string;
    };
  };

  if (!data.ok) {
    throw new Error(data.error || 'Slack OAuth token exchange failed');
  }

  return {
    accessToken: data.access_token ?? null,
    teamId: data.team?.id ?? null,
    teamName: data.team?.name ?? null,
    webhookUrl: data.incoming_webhook?.url ?? null,
    channelName: data.incoming_webhook?.channel ?? null,
    channelId: data.incoming_webhook?.channel_id ?? null,
  };
}

export async function sendSlackMessageToUser(
  userId: number,
  text: string
): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const user = rows[0];
    if (!user) return false;

    if (user.slackWebhookUrl) {
      const resp = await fetch(user.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        console.error('Slack webhook post failed:', resp.status, await resp.text());
        return false;
      }
      return true;
    }

    if (user.slackAccessToken && user.slackChannelId) {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.slackAccessToken}`,
        },
        body: JSON.stringify({
          channel: user.slackChannelId,
          text,
        }),
      });
      const json = (await resp.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        console.error('Slack chat.postMessage failed:', json.error);
        return false;
      }
      return true;
    }

    // User has not connected Slack; skip gracefully
    return false;
  } catch (error) {
    console.error('Error sending Slack notification:', error);
    return false;
  }
}

export async function sendSlackRateLimitAlert(params: {
  userId: number;
  senderEmail: string;
  senderName: string;
  hourlyLimit: number;
  hourWindow: string;
  nextWindowIso: string;
}): Promise<boolean> {
  const message = [
    `*Outboxly Rate Limit Reached*`,
    `Sender: *${params.senderName}* (${params.senderEmail})`,
    `Hourly Limit: *${params.hourlyLimit} emails/hour* reached during window \`${params.hourWindow}\``,
    `Action: Remaining queued emails have been automatically rescheduled to the next hour window starting at \`${params.nextWindowIso}\`.`,
  ].join('\n');

  return sendSlackMessageToUser(params.userId, message);
}
