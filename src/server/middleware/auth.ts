import type { NextFunction, Request, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getOrCreateUser, getUserById } from '../../db/users.ts';
import { adminAuth } from '../../lib/firebase-admin.ts';
import { isSessionToken, verifySessionToken } from '../services/sessionAuth.ts';

export interface DbUserRecord {
  id: number;
  uid: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  slackTeamId: string | null;
  slackTeamName: string | null;
  slackChannelName: string | null;
  slackChannelId: string | null;
  slackWebhookUrl: string | null;
  slackAccessToken: string | null;
  slackConnectedAt: Date | null;
}

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
  dbUser?: DbUserRecord;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Empty bearer token' });
    return;
  }

  try {
    if (isSessionToken(token)) {
      const payload = verifySessionToken(token);
      if (!payload) {
        res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
        return;
      }
      const dbUser = await getUserById(payload.userId);
      if (!dbUser || dbUser.uid !== payload.uid) {
        res.status(401).json({ error: 'Unauthorized: Account not found' });
        return;
      }
      req.dbUser = dbUser;
      next();
      return;
    }

    const decoded = await adminAuth.verifyIdToken(token);
    req.user = decoded;
    const dbUser = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email ?? '',
      name: decoded.name ?? null,
      avatarUrl: decoded.picture ?? null,
    });
    req.dbUser = dbUser;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};
