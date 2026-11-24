import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getGmailToken } from './gmailTokenStore.ts';

const transporterCache = new Map<string, Transporter>();

export type DeliveryMode = 'gmail-api' | 'smtp-live' | 'ethereal-sandbox';

export interface SenderSmtpConfig {
  id: number;
  userId?: number;
  name: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
}

export function getDeliveryMode(smtpHost: string): DeliveryMode {
  const host = smtpHost.trim().toLowerCase();
  if (host === 'gmail-api') return 'gmail-api';
  if (host.includes('ethereal.email')) return 'ethereal-sandbox';
  return 'smtp-live';
}

export async function createEtherealTestAccount() {
  const account = await nodemailer.createTestAccount();
  return {
    smtpHost: account.smtp.host,
    smtpPort: account.smtp.port,
    smtpUser: account.user,
    smtpPass: account.pass,
    email: account.user,
    etherealWebUrl: account.web,
  };
}

function getCacheKey(sender: SenderSmtpConfig): string {
  const passDigest = crypto
    .createHash('sha256')
    .update(sender.smtpPass || '')
    .digest('hex')
    .slice(0, 12);
  return `${sender.id}:${sender.smtpHost}:${sender.smtpPort}:${sender.smtpUser}:${passDigest}`;
}

function buildSmtpTransportOptions(sender: SenderSmtpConfig, pooled: boolean) {
  const isLocal =
    sender.smtpHost === 'localhost' || sender.smtpHost === '127.0.0.1';
  const secure = sender.smtpPort === 465;

  return {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure,
    requireTLS: !secure && sender.smtpPort === 587 && !isLocal,
    auth: {
      user: sender.smtpUser,
      pass: sender.smtpPass,
    },
    pool: pooled,
    maxConnections: pooled ? 5 : 1,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: isLocal ? undefined : { minVersion: 'TLSv1.2' as const },
  };
}

function getTransporter(sender: SenderSmtpConfig): Transporter {
  const cacheKey = getCacheKey(sender);
  const existing = transporterCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions(sender, true)
  );

  transporterCache.set(cacheKey, transporter);
  return transporter;
}

export function formatSmtpError(err: unknown, smtpHost: string): string {
  const raw = err instanceof Error ? err.message : 'SMTP connection failed';
  const lower = raw.toLowerCase();

  if (
    smtpHost.toLowerCase().includes('gmail') &&
    (lower.includes('535') ||
      lower.includes('username and password not accepted') ||
      lower.includes('invalid login') ||
      lower.includes('application-specific password'))
  ) {
    return 'Gmail SMTP rejected the credentials. Enable 2-Step Verification on your Google Account and use a 16-character App Password (not your regular Gmail password).';
  }

  if (lower.includes('invalid login') || lower.includes('535')) {
    return 'SMTP authentication failed. Verify your SMTP username and password/API key.';
  }

  if (lower.includes('econnrefused') || lower.includes('enotfound')) {
    return `Could not reach SMTP host "${smtpHost}". Check the hostname and port.`;
  }

  if (lower.includes('etimedout') || lower.includes('timeout')) {
    return `Connection to "${smtpHost}" timed out. Try port 465 (SSL) or 587 (STARTTLS).`;
  }

  return raw;
}

export async function verifySmtpConnection(sender: SenderSmtpConfig): Promise<void> {
  if (sender.smtpHost === 'gmail-api') return;

  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions(sender, false)
  );
  try {
    await transporter.verify();
  } catch (err) {
    throw new Error(formatSmtpError(err, sender.smtpHost));
  } finally {
    transporter.close();
  }
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />');
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage(params: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const safeName = sanitizeHeaderValue(params.fromName).replace(/"/g, '');
  const safeFrom = sanitizeHeaderValue(params.fromEmail);
  const safeTo = sanitizeHeaderValue(params.to);
  const safeSubject = sanitizeHeaderValue(params.subject);
  const encodedSubject = `=?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`;
  const boundary = `obx_${crypto.randomBytes(12).toString('hex')}`;
  const htmlBody = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0f172a;">${escapeHtml(
    params.body
  )}</div>`;

  const textB64 = Buffer.from(params.body, 'utf8').toString('base64');
  const htmlB64 = Buffer.from(htmlBody, 'utf8').toString('base64');

  return [
    `From: "${safeName}" <${safeFrom}>`,
    `To: ${safeTo}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    textB64,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

async function sendViaGmailApi(params: {
  accessToken: string;
  sender: SenderSmtpConfig;
  to: string;
  subject: string;
  body: string;
}): Promise<{ messageId: string; previewUrl: string | null }> {
  const rawMime = buildMimeMessage({
    fromName: params.sender.name,
    fromEmail: params.sender.email,
    to: params.to,
    subject: params.subject,
    body: params.body,
  });

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: encodeBase64Url(rawMime),
      }),
    }
  );

  const data = (await response.json().catch(() => null)) as
    | { id?: string; error?: { message?: string; code?: number } }
    | null;

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Gmail authorization expired or missing send permission. Reconnect Gmail in Integrations, or configure a Gmail App Password SMTP sender.'
      );
    }
    throw new Error(
      data?.error?.message || `Gmail API delivery failed (${response.status})`
    );
  }

  return {
    messageId: data?.id || `gmail:${crypto.randomUUID()}`,
    previewUrl: null,
  };
}

export async function sendEmailViaSender(params: {
  sender: SenderSmtpConfig;
  to: string;
  subject: string;
  body: string;
  gmailAccessToken?: string | null;
}): Promise<{ messageId: string; previewUrl: string | null }> {
  if (params.sender.smtpHost === 'gmail-api') {
    const token =
      params.gmailAccessToken?.trim() ||
      (typeof params.sender.userId === 'number'
        ? getGmailToken(params.sender.userId)?.accessToken
        : null);

    if (!token) {
      throw new Error(
        'Gmail session expired or server restarted. Reconnect Gmail in Integrations, or add a Gmail App Password SMTP sender for unattended schedules.'
      );
    }

    return sendViaGmailApi({
      accessToken: token,
      sender: params.sender,
      to: params.to,
      subject: params.subject,
      body: params.body,
    });
  }

  const cacheKey = getCacheKey(params.sender);
  const transporter = getTransporter(params.sender);

  try {
    const info = await transporter.sendMail({
      from: `"${sanitizeHeaderValue(params.sender.name)}" <${sanitizeHeaderValue(
        params.sender.email
      )}>`,
      to: params.to,
      subject: params.subject,
      text: params.body,
      html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0f172a;">${escapeHtml(
        params.body
      )}</div>`,
    });

    const testUrl = nodemailer.getTestMessageUrl(info);
    return {
      messageId: info.messageId,
      previewUrl: typeof testUrl === 'string' ? testUrl : null,
    };
  } catch (err) {
    transporterCache.delete(cacheKey);
    try {
      transporter.close();
    } catch {
      // ignore close errors
    }
    throw new Error(formatSmtpError(err, params.sender.smtpHost));
  }
}
