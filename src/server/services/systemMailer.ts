import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { systemMailConfig } from '../../db/schema.ts';
import { env } from '../config/env.ts';
import {
  createEtherealTestAccount,
  formatSmtpError,
  sendEmailViaSender,
} from './mailer.ts';

let cachedEtherealSystemAccount: {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  email: string;
} | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isEtherealEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@ethereal.email');
}

export interface SystemMailerStatus {
  configured: boolean;
  source: 'env-resend' | 'env-smtp' | 'database' | 'sandbox';
  fromName: string;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  warning?: string | null;
}

export async function getSystemMailerStatus(): Promise<SystemMailerStatus> {
  const rows = await db
    .select({
      fromName: systemMailConfig.fromName,
      fromEmail: systemMailConfig.fromEmail,
      smtpHost: systemMailConfig.smtpHost,
      smtpPort: systemMailConfig.smtpPort,
    })
    .from(systemMailConfig)
    .where(eq(systemMailConfig.id, 1))
    .limit(1);

  if (rows[0]) {
    return {
      configured: true,
      source: 'database',
      fromName: rows[0].fromName,
      fromEmail: rows[0].fromEmail,
      smtpHost: rows[0].smtpHost,
      smtpPort: rows[0].smtpPort,
      warning: null,
    };
  }

  if (env.systemSmtpHost && env.systemSmtpUser && env.systemSmtpPass) {
    return {
      configured: true,
      source: 'env-smtp',
      fromName: env.systemFromName,
      fromEmail: env.systemFromEmail || env.systemSmtpUser,
      smtpHost: env.systemSmtpHost,
      smtpPort: env.systemSmtpPort,
      warning: null,
    };
  }

  if (env.resendApiKey && env.systemFromEmail) {
    if (!isEtherealEmail(env.systemFromEmail)) {
      return {
        configured: true,
        source: 'env-resend',
        fromName: env.systemFromName,
        fromEmail: env.systemFromEmail,
        smtpHost: 'api.resend.com',
        smtpPort: 443,
        warning: null,
      };
    }

    return {
      configured: false,
      source: 'sandbox',
      fromName: env.systemFromName,
      fromEmail: null,
      smtpHost: null,
      smtpPort: null,
      warning:
        'SYSTEM_FROM_EMAIL is currently set to an ethereal.email address, which cannot be verified on Resend. Add a Gmail App Password or verified SMTP sender above and click "Use for Signup Mail" for real inbox verification.',
    };
  }

  return {
    configured: false,
    source: 'sandbox',
    fromName: env.systemFromName,
    fromEmail: null,
    smtpHost: null,
    smtpPort: null,
    warning: null,
  };
}

export async function getSystemSmtpCredentials(): Promise<{
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
} | null> {
  const rows = await db
    .select()
    .from(systemMailConfig)
    .where(eq(systemMailConfig.id, 1))
    .limit(1);

  if (rows[0]) {
    return {
      fromName: rows[0].fromName,
      fromEmail: rows[0].fromEmail,
      smtpHost: rows[0].smtpHost,
      smtpPort: rows[0].smtpPort,
      smtpUser: rows[0].smtpUser,
      smtpPass: rows[0].smtpPass,
    };
  }

  if (env.systemSmtpHost && env.systemSmtpUser && env.systemSmtpPass) {
    return {
      fromName: env.systemFromName,
      fromEmail: env.systemFromEmail || env.systemSmtpUser,
      smtpHost: env.systemSmtpHost,
      smtpPort: env.systemSmtpPort,
      smtpUser: env.systemSmtpUser,
      smtpPass: env.systemSmtpPass,
    };
  }

  return null;
}

export async function sendSignupVerificationEmail(params: {
  to: string;
  name: string;
  code: string;
  verifyUrl: string;
}): Promise<{
  deliveryMode: 'smtp-live' | 'ethereal-sandbox';
  previewUrl: string | null;
  fallbackNotice: string | null;
}> {
  const safeName = escapeHtml(params.name);
  const safeCode = escapeHtml(params.code);
  const safeUrl = escapeHtml(params.verifyUrl);

  const subject = `${params.code} is your Outboxly verification code`;
  const textBody = [
    `Hi ${params.name},`,
    '',
    `Your Outboxly verification code is: ${params.code}`,
    '',
    `Or click this link to verify and complete registration:`,
    params.verifyUrl,
    '',
    'This code expires in 15 minutes. If you did not request this signup, you can safely ignore this email.',
  ].join('\n');

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0f172a; line-height: 1.6;">
      <h2 style="margin: 0 0 12px; font-size: 18px; color: #0f172a;">Verify your Outboxly account</h2>
      <p style="margin: 0 0 16px; font-size: 14px; color: #334155;">Hi ${safeName}, enter the verification code below to complete your registration:</p>
      <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; text-align: center;">
        <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #1d4ed8;">${safeCode}</span>
      </div>
      <p style="margin: 0 0 16px; font-size: 14px; color: #334155;">Or verify directly with one click:</p>
      <p style="margin: 0 0 24px;">
        <a href="${safeUrl}" style="display: inline-block; padding: 10px 18px; background: #1d4ed8; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; border-radius: 6px;">Verify Email &amp; Register</a>
      </p>
      <p style="margin: 0; font-size: 12px; color: #64748b;">This code expires in 15 minutes. If you did not sign up for Outboxly, ignore this email.</p>
    </div>
  `;

  // 1. Configured Live System SMTP (database system_mail_config or SYSTEM_SMTP_* env)
  const systemSmtp = await getSystemSmtpCredentials();
  if (systemSmtp) {
    const secure = systemSmtp.smtpPort === 465;
    const transporter = nodemailer.createTransport({
      host: systemSmtp.smtpHost,
      port: systemSmtp.smtpPort,
      secure,
      requireTLS: !secure && systemSmtp.smtpPort === 587,
      auth: {
        user: systemSmtp.smtpUser,
        pass: systemSmtp.smtpPass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      tls: { minVersion: 'TLSv1.2' },
    });

    try {
      const info = await transporter.sendMail({
        from: `"${systemSmtp.fromName.replace(/"/g, '')}" <${systemSmtp.fromEmail}>`,
        to: params.to,
        subject,
        text: textBody,
        html: htmlBody,
      });
      const testUrl = nodemailer.getTestMessageUrl(info);
      return {
        deliveryMode: systemSmtp.smtpHost.includes('ethereal.email')
          ? 'ethereal-sandbox'
          : 'smtp-live',
        previewUrl: typeof testUrl === 'string' ? testUrl : null,
        fallbackNotice: null,
      };
    } catch (err) {
      throw new Error(formatSmtpError(err, systemSmtp.smtpHost));
    } finally {
      transporter.close();
    }
  }

  let fallbackNotice: string | null = null;

  // 2. Resend API (if configured in environment secrets with a non-ethereal domain)
  if (env.resendApiKey && env.systemFromEmail) {
    if (isEtherealEmail(env.systemFromEmail)) {
      fallbackNotice =
        'SYSTEM_FROM_EMAIL is set to an ethereal.email sandbox address, which Resend cannot send from. Using Ethereal verification preview for now — configure a Gmail App Password or verified domain in Integrations → Signup Verification Mailer for real inbox delivery.';
      console.warn(fallbackNotice);
    } else {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${env.systemFromName} <${env.systemFromEmail}>`,
            to: [params.to],
            subject,
            text: textBody,
            html: htmlBody,
          }),
        });
        if (res.ok) {
          return {
            deliveryMode: 'smtp-live',
            previewUrl: null,
            fallbackNotice: null,
          };
        }

        const errData = (await res.json().catch(() => null)) as
          | { message?: string; name?: string }
          | null;
        const msg = errData?.message || `Resend returned HTTP ${res.status}`;

        if (res.status === 403 || res.status === 422 || errData?.name === 'validation_error') {
          fallbackNotice = `Resend could not send from ${env.systemFromEmail} (${msg}). Using Ethereal verification preview for now — verify your domain on resend.com/domains or configure Gmail App Password SMTP in Integrations → Signup Verification Mailer.`;
          console.warn(fallbackNotice);
        } else {
          throw new Error(`Verification email delivery failed: ${msg}`);
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith('Verification email delivery failed:')
        ) {
          throw err;
        }
        fallbackNotice =
          'Unable to reach Resend API; falling back to Ethereal verification preview.';
        console.warn(fallbackNotice, err);
      }
    }
  }

  // 3. Ethereal sandbox fallback for preview testing before live System SMTP is set
  if (!cachedEtherealSystemAccount) {
    const account = await createEtherealTestAccount();
    cachedEtherealSystemAccount = {
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpUser: account.smtpUser,
      smtpPass: account.smtpPass,
      email: account.email,
    };
  }

  const res = await sendEmailViaSender({
    sender: {
      id: -1,
      name: env.systemFromName,
      email: cachedEtherealSystemAccount.email,
      smtpHost: cachedEtherealSystemAccount.smtpHost,
      smtpPort: cachedEtherealSystemAccount.smtpPort,
      smtpUser: cachedEtherealSystemAccount.smtpUser,
      smtpPass: cachedEtherealSystemAccount.smtpPass,
    },
    to: params.to,
    subject,
    body: textBody,
  });

  return {
    deliveryMode: 'ethereal-sandbox',
    previewUrl: res.previewUrl,
    fallbackNotice,
  };
}
