import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export interface UserProfileInput {
  uid: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export async function getOrCreateUser(input: UserProfileInput) {
  try {
    const result = await db
      .insert(users)
      .values({
        uid: input.uid,
        email: input.email,
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: input.email,
          ...(input.name ? { name: input.name } : {}),
          ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Failed to upsert user:', error);
    throw new Error('Database error while synchronizing user profile.', {
      cause: error,
    });
  }
}

export async function getUserByUid(uid: string) {
  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Failed to query user by UID:', error);
    throw new Error('Database error while fetching user profile.', {
      cause: error,
    });
  }
}

export async function getUserById(id: number) {
  try {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Failed to query user by ID:', error);
    throw new Error('Database error while fetching user profile.', {
      cause: error,
    });
  }
}
