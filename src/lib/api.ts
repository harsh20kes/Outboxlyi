import type {
  EmailSearchResponse,
  EmailsListResponse,
  GmailStatusResponse,
  PendingSignupResult,
  QueueTelemetry,
  SenderAccount,
  SystemMailerStatus,
  SystemStatus,
  UserProfile,
} from '../types/scheduler.ts';

async function apiRequest<T>(
  path: string,
  token: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : null;

  if (!response.ok) {
    const errorMsg =
      (data && typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status})`;
    throw new Error(errorMsg);
  }

  return data as T;
}

async function publicAuthRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) {
    const errorMsg =
      (data && typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status})`;
    throw new Error(errorMsg);
  }
  return data as T;
}

export function signupWithPassword(payload: {
  name: string;
  email: string;
  password: string;
}) {
  return publicAuthRequest<PendingSignupResult>('/api/auth/signup', payload);
}

export function verifySignupEmail(payload: {
  email?: string;
  code?: string;
  token?: string;
}) {
  return publicAuthRequest<{ token: string; user: UserProfile }>(
    '/api/auth/verify-email',
    payload
  );
}

export function resendVerificationEmail(email: string) {
  return publicAuthRequest<PendingSignupResult>(
    '/api/auth/resend-verification',
    { email }
  );
}

export function loginWithPassword(payload: {
  email: string;
  password: string;
}) {
  return publicAuthRequest<{ token: string; user: UserProfile }>(
    '/api/auth/login',
    payload
  );
}

export function fetchUserProfile(token: string) {
  return apiRequest<UserProfile>('/api/me', token);
}

export function fetchSystemStatus(token: string) {
  return apiRequest<SystemStatus>('/api/system/status', token);
}

export function fetchSystemMailerStatus(token: string) {
  return apiRequest<SystemMailerStatus>('/api/system/mailer', token);
}

export function configureSystemMailer(
  token: string,
  payload:
    | { senderId: number }
    | {
        fromName: string;
        fromEmail: string;
        smtpHost: string;
        smtpPort: number;
        smtpUser: string;
        smtpPass: string;
      }
) {
  return apiRequest<SystemMailerStatus>('/api/system/mailer', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function clearSystemMailer(token: string) {
  return apiRequest<SystemMailerStatus>('/api/system/mailer', token, {
    method: 'DELETE',
  });
}

export function fetchSenders(token: string) {
  return apiRequest<{ senders: SenderAccount[] }>('/api/senders', token);
}

export function createEtherealSender(
  token: string,
  payload: { name?: string; hourlyLimit?: number }
) {
  return apiRequest<{ sender: SenderAccount }>('/api/senders/ethereal', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createManualSender(
  token: string,
  payload: {
    name: string;
    email: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    hourlyLimit?: number;
  }
) {
  return apiRequest<{ sender: SenderAccount }>('/api/senders', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function registerGmailSender(
  token: string,
  gmailAccessToken: string,
  payload?: { name?: string }
) {
  return apiRequest<{
    sender: SenderAccount;
    gmailConnected: boolean;
    gmailEmail: string;
  }>('/api/senders/gmail', token, {
    method: 'POST',
    headers: {
      'X-Gmail-Access-Token': gmailAccessToken,
    },
    body: JSON.stringify(payload ?? {}),
  });
}

export function syncGmailAccessToken(token: string, gmailAccessToken: string) {
  return apiRequest<{ connected: boolean; gmailEmail: string }>(
    '/api/gmail/token',
    token,
    {
      method: 'POST',
      headers: {
        'X-Gmail-Access-Token': gmailAccessToken,
      },
      body: JSON.stringify({}),
    }
  );
}

export function fetchGmailStatus(token: string) {
  return apiRequest<GmailStatusResponse>('/api/gmail/status', token);
}

export function clearServerGmailToken(token: string) {
  return apiRequest<{ disconnected: boolean }>('/api/gmail/disconnect', token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function sendTestEmail(
  token: string,
  senderId: number,
  payload: { to: string; subject?: string; body?: string },
  gmailAccessToken?: string | null
) {
  const extraHeaders: Record<string, string> = {};
  if (gmailAccessToken) {
    extraHeaders['X-Gmail-Access-Token'] = gmailAccessToken;
  }

  return apiRequest<{
    sent: boolean;
    messageId: string;
    previewUrl: string | null;
    deliveryMode: SenderAccount['deliveryMode'];
  }>(`/api/senders/${senderId}/test`, token, {
    method: 'POST',
    headers: extraHeaders,
    body: JSON.stringify(payload),
  });
}

export function deleteSender(token: string, senderId: number) {
  return apiRequest<{ deleted: boolean }>(`/api/senders/${senderId}`, token, {
    method: 'DELETE',
  });
}

export function scheduleEmailBatch(
  token: string,
  payload: {
    senderId: number;
    subject: string;
    body: string;
    recipients: string[];
    startTime: string;
    delaySeconds: number;
    hourlyLimit: number;
    batchKey: string;
  },
  gmailAccessToken?: string | null
) {
  const extraHeaders: Record<string, string> = {};
  if (gmailAccessToken) {
    extraHeaders['X-Gmail-Access-Token'] = gmailAccessToken;
  }

  return apiRequest<{
    batchId: number;
    scheduledCount: number;
    queuedInBullMQ: boolean;
    warning: string | null;
  }>('/api/emails/schedule', token, {
    method: 'POST',
    headers: extraHeaders,
    body: JSON.stringify(payload),
  });
}

export function fetchEmails(
  token: string,
  params: {
    tab: 'scheduled' | 'sent';
    status?: string;
    senderId?: number | '';
    search?: string;
    page?: number;
    pageSize?: number;
  }
) {
  const qs = new URLSearchParams({
    tab: params.tab,
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.status) qs.set('status', params.status);
  if (params.senderId) qs.set('senderId', String(params.senderId));
  if (params.search) qs.set('search', params.search);

  return apiRequest<EmailsListResponse>(`/api/emails?${qs.toString()}`, token);
}

export function searchEmails(
  token: string,
  query: string,
  tab: 'scheduled' | 'sent' | 'all'
) {
  const qs = new URLSearchParams({ q: query, tab });
  return apiRequest<EmailSearchResponse>(
    `/api/emails/search?${qs.toString()}`,
    token
  );
}

export function fetchQueueTelemetry(token: string) {
  return apiRequest<QueueTelemetry>('/api/queues/stats', token);
}

export function rehydrateQueueJobs(token: string) {
  return apiRequest<{ rehydratedCount: number }>(
    '/api/queues/rehydrate',
    token,
    { method: 'POST' }
  );
}

export function getSlackAuthUrl(token: string) {
  return apiRequest<{ url: string }>('/api/slack/auth-url', token);
}

export function sendSlackTestAlert(token: string) {
  return apiRequest<{ sent: boolean }>('/api/slack/test', token, {
    method: 'POST',
  });
}

export function disconnectSlack(token: string) {
  return apiRequest<{ disconnected: boolean }>('/api/slack/disconnect', token, {
    method: 'POST',
  });
}
