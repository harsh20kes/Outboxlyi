import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { db } from '../../db/index.ts';
import { pendingSignups, users } from '../../db/schema.ts';
import { env } from '../config/env.ts';
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
} from '../services/sessionAuth.ts';
import { getSlackRedirectUri, isSlackConfigured } from '../services/slack.ts';
import { sendSignupVerificationEmail } from '../services/systemMailer.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

export const authRouter = Router();

function formatUserDto(user: typeof users.$inferSelect) {
  return {
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
  };
}

function hashVerificationCode(email: string, code: string): string {
  return crypto
    .createHmac('sha256', env.sessionSecret)
    .update(`verify-code:${email.toLowerCase()}:${code.trim()}`)
    .digest('hex');
}

function hashVerificationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

function timingSafeHexMatch(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolvePublicOrigin(req: Request): string {
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return env.appUrl || `http://${host || 'localhost:3000'}`;
}

authRouter.post('/signup', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Please enter your full name.' });
    return;
  }
  if (!EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    return;
  }

  try {
    const existing = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existing[0]) {
      if (existing[0].passwordHash) {
        res.status(409).json({
          error: 'An account with this email already exists. Please sign in instead.',
        });
      } else {
        res.status(409).json({
          error: 'This email is linked to Google Sign-In. Please continue with Google.',
        });
      }
      return;
    }

    const passwordHash = await hashPassword(password);
    const code = String(crypto.randomInt(100000, 1000000));
    const rawToken = crypto.randomBytes(32).toString('hex');
    const codeHash = hashVerificationCode(email, code);
    const tokenHash = hashVerificationToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    const now = new Date();

    await db
      .insert(pendingSignups)
      .values({
        email,
        name: name.slice(0, 120),
        passwordHash,
        codeHash,
        tokenHash,
        attempts: 0,
        expiresAt,
        lastSentAt: now,
      })
      .onConflictDoUpdate({
        target: pendingSignups.email,
        set: {
          name: name.slice(0, 120),
          passwordHash,
          codeHash,
          tokenHash,
          attempts: 0,
          expiresAt,
          lastSentAt: now,
        },
      });

    const verifyUrl = `${resolvePublicOrigin(req)}/?verifyToken=${encodeURIComponent(rawToken)}`;

    let mailResult: {
      deliveryMode: 'smtp-live' | 'ethereal-sandbox';
      previewUrl: string | null;
      fallbackNotice?: string | null;
    };
    try {
      mailResult = await sendSignupVerificationEmail({
        to: email,
        name: name.slice(0, 120),
        code,
        verifyUrl,
      });
    } catch (mailError) {
      await db.delete(pendingSignups).where(eq(pendingSignups.email, email));
      console.error('Verification email dispatch failed:', mailError);
      res.status(502).json({
        error:
          mailError instanceof Error
            ? mailError.message
            : 'Unable to send verification email. Check system SMTP settings.',
      });
      return;
    }

    res.status(202).json({
      pendingVerification: true,
      email,
      deliveryMode: mailResult.deliveryMode,
      previewUrl:
        mailResult.deliveryMode === 'ethereal-sandbox'
          ? mailResult.previewUrl
          : null,
      fallbackNotice: mailResult.fallbackNotice ?? null,
    });
  } catch (error) {
    console.error('Signup failed:', error);
    res.status(500).json({ error: 'Unable to initiate signup. Please try again.' });
  }
});

authRouter.post('/verify-email', async (req, res) => {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

  if (!rawToken && (!EMAIL_REGEX.test(email) || !/^\d{6}$/.test(code))) {
    res.status(400).json({
      error: 'Please enter the 6-digit verification code sent to your email.',
    });
    return;
  }

  try {
    let pendingRow: typeof pendingSignups.$inferSelect | undefined;

    if (rawToken) {
      const tokenDigest = hashVerificationToken(rawToken);
      const rows = await db
        .select()
        .from(pendingSignups)
        .where(eq(pendingSignups.tokenHash, tokenDigest))
        .limit(1);
      pendingRow = rows[0];
    } else {
      const rows = await db
        .select()
        .from(pendingSignups)
        .where(eq(pendingSignups.email, email))
        .limit(1);
      pendingRow = rows[0];
    }

    if (!pendingRow) {
      res.status(400).json({
        error:
          'No pending verification found for this email or link. Please sign up again.',
      });
      return;
    }

    if (pendingRow.expiresAt.getTime() < Date.now()) {
      res.status(400).json({
        error: 'Verification code has expired. Click Resend Code to get a new one.',
      });
      return;
    }

    if (!rawToken) {
      if (pendingRow.attempts >= MAX_VERIFY_ATTEMPTS) {
        res.status(429).json({
          error:
            'Too many incorrect attempts. Please click Resend Code for a new verification code.',
        });
        return;
      }

      const candidateHash = hashVerificationCode(pendingRow.email, code);
      if (!timingSafeHexMatch(candidateHash, pendingRow.codeHash)) {
        await db
          .update(pendingSignups)
          .set({ attempts: pendingRow.attempts + 1 })
          .where(eq(pendingSignups.id, pendingRow.id));

        res.status(400).json({ error: 'Invalid verification code. Please try again.' });
        return;
      }
    }

    // Re-check if already registered concurrently
    const existing = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${pendingRow.email}`)
      .limit(1);

    let registeredUser = existing[0];
    if (!registeredUser) {
      const uid = `local:${crypto.randomUUID()}`;
      const [created] = await db
        .insert(users)
        .values({
          uid,
          email: pendingRow.email,
          name: pendingRow.name,
          passwordHash: pendingRow.passwordHash,
          emailVerified: true,
        })
        .returning();
      registeredUser = created;
    }

    await db.delete(pendingSignups).where(eq(pendingSignups.id, pendingRow.id));

    const token = createSessionToken(registeredUser.id, registeredUser.uid);
    res.json({
      token,
      user: formatUserDto(registeredUser),
    });
  } catch (error) {
    console.error('Email verification failed:', error);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

authRouter.post('/resend-verification', async (req, res) => {
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  if (!EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(pendingSignups)
      .where(eq(pendingSignups.email, email))
      .limit(1);

    const pendingRow = rows[0];
    if (!pendingRow) {
      res.status(404).json({
        error: 'No pending signup found for this email. Please fill out the signup form.',
      });
      return;
    }

    const elapsedMs = Date.now() - pendingRow.lastSentAt.getTime();
    if (elapsedMs < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
      res.status(429).json({
        error: `Please wait ${waitSec}s before requesting another code.`,
      });
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const rawToken = crypto.randomBytes(32).toString('hex');
    const codeHash = hashVerificationCode(email, code);
    const tokenHash = hashVerificationToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    await db
      .update(pendingSignups)
      .set({
        codeHash,
        tokenHash,
        attempts: 0,
        expiresAt,
        lastSentAt: now,
      })
      .where(eq(pendingSignups.id, pendingRow.id));

    const verifyUrl = `${resolvePublicOrigin(req)}/?verifyToken=${encodeURIComponent(rawToken)}`;
    const mailResult = await sendSignupVerificationEmail({
      to: email,
      name: pendingRow.name,
      code,
      verifyUrl,
    });

    res.json({
      pendingVerification: true,
      email,
      deliveryMode: mailResult.deliveryMode,
      previewUrl:
        mailResult.deliveryMode === 'ethereal-sandbox'
          ? mailResult.previewUrl
          : null,
      fallbackNotice: mailResult.fallbackNotice ?? null,
    });
  } catch (error) {
    console.error('Resend verification failed:', error);
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : 'Unable to resend verification email.',
    });
  }
});

authRouter.post('/login', async (req, res) => {
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!EMAIL_REGEX.test(email) || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    const user = rows[0];
    if (!user) {
      const pending = await db
        .select({ id: pendingSignups.id })
        .from(pendingSignups)
        .where(eq(pendingSignups.email, email))
        .limit(1);

      if (pending[0]) {
        res.status(403).json({
          error:
            'Your email is not verified yet. Complete email verification in Create Account.',
        });
        return;
      }

      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (!user.passwordHash) {
      res.status(401).json({
        error: 'This account uses Google Sign-In. Please continue with Google.',
      });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = createSessionToken(user.id, user.uid);
    res.json({
      token,
      user: formatUserDto(user),
    });
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ error: 'Sign in failed. Please try again.' });
  }
});
