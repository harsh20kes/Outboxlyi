import { Client } from '@elastic/elasticsearch';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { emails, senders } from '../../db/schema.ts';
import { env } from '../config/env.ts';

const INDEX_NAME = 'reachinbox_emails';

let esClient: Client | null = null;
let esReady = false;
let esLastError: string | null = null;
let indexVerified = false;

export interface EmailIndexDoc {
  id: number;
  batchId: number;
  userId: number;
  senderId: number;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  etherealPreviewUrl: string | null;
  errorMessage: string | null;
}

export async function initElasticsearch(): Promise<void> {
  if (!env.elasticsearchUrl) {
    esClient = null;
    esReady = false;
    esLastError = 'ELASTICSEARCH_URL not configured';
    return;
  }

  try {
    esClient = new Client({
      node: env.elasticsearchUrl,
      ...(env.elasticsearchApiKey
        ? { auth: { apiKey: env.elasticsearchApiKey } }
        : {}),
    });

    await esClient.ping();
    await ensureIndexExists();
    esReady = true;
    esLastError = null;
    console.log('Elasticsearch connected and index verified.');
  } catch (error) {
    esReady = false;
    esLastError = error instanceof Error ? error.message : 'Elasticsearch unreachable';
    console.warn('Elasticsearch initialization skipped/unavailable:', esLastError);
  }
}

async function ensureIndexExists(): Promise<void> {
  if (!esClient || indexVerified) return;

  const exists = await esClient.indices.exists({ index: INDEX_NAME });
  if (!exists) {
    await esClient.indices.create({
      index: INDEX_NAME,
      mappings: {
        properties: {
          id: { type: 'integer' },
          batchId: { type: 'integer' },
          userId: { type: 'integer' },
          senderId: { type: 'integer' },
          senderEmail: { type: 'keyword' },
          recipientEmail: {
            type: 'text',
            fields: { keyword: { type: 'keyword' } },
          },
          subject: { type: 'text' },
          body: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
          etherealPreviewUrl: { type: 'keyword' },
          errorMessage: { type: 'text' },
        },
      },
    });
  }
  indexVerified = true;
}

export async function indexEmailDocuments(docs: EmailIndexDoc[]): Promise<void> {
  if (!esClient || !esReady || docs.length === 0) return;
  try {
    await ensureIndexExists();
    const operations = docs.flatMap((doc) => [
      { index: { _index: INDEX_NAME, _id: String(doc.id) } },
      doc,
    ]);
    await esClient.bulk({ refresh: true, operations });
  } catch (error) {
    console.error('Elasticsearch bulk index error:', error);
  }
}

export async function updateEmailIndexStatus(
  emailId: number,
  patch: Partial<Pick<EmailIndexDoc, 'status' | 'sentAt' | 'etherealPreviewUrl' | 'errorMessage' | 'scheduledAt'>>
): Promise<void> {
  if (!esClient || !esReady) return;
  try {
    await esClient.update({
      index: INDEX_NAME,
      id: String(emailId),
      doc: patch,
      doc_as_upsert: false,
      refresh: true,
    });
  } catch (error) {
    console.error('Elasticsearch status update error:', error);
  }
}

export async function searchEmailsWithFallback(params: {
  userId: number;
  query: string;
  tab?: 'scheduled' | 'sent' | 'all';
  limit?: number;
}) {
  const trimmed = params.query.trim();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const statusFilter =
    params.tab === 'scheduled'
      ? ['scheduled', 'delayed', 'processing']
      : params.tab === 'sent'
        ? ['sent', 'failed']
        : null;

  if (esClient && esReady && trimmed.length > 0) {
    try {
      const mustClauses: Record<string, unknown>[] = [
        {
          multi_match: {
            query: trimmed,
            fields: ['recipientEmail^3', 'subject^2', 'body', 'senderEmail'],
            type: 'best_fields',
            fuzziness: 'AUTO',
          },
        },
      ];

      const filterClauses: Record<string, unknown>[] = [
        { term: { userId: params.userId } },
      ];
      if (statusFilter) {
        filterClauses.push({ terms: { status: statusFilter } });
      }

      const response = await esClient.search<EmailIndexDoc>({
        index: INDEX_NAME,
        size: limit,
        query: {
          bool: {
            must: mustClauses,
            filter: filterClauses,
          },
        },
        sort: [{ scheduledAt: 'desc' }],
      });

      const hits = response.hits.hits
        .map((h) => h._source)
        .filter((s): s is EmailIndexDoc => Boolean(s));

      return {
        engine: 'elasticsearch' as const,
        items: hits,
        total: hits.length,
      };
    } catch (error) {
      console.error('Elasticsearch search failed, falling back to PostgreSQL:', error);
    }
  }

  // Parameterized PostgreSQL fallback search
  const pattern = `%${trimmed}%`;
  const conditions = [eq(emails.userId, params.userId)];

  if (statusFilter) {
    conditions.push(inArray(emails.status, statusFilter));
  }
  if (trimmed.length > 0) {
    const searchCond = or(
      ilike(emails.recipientEmail, pattern),
      ilike(emails.subject, pattern),
      ilike(emails.body, pattern),
      ilike(senders.email, pattern)
    );
    if (searchCond) {
      conditions.push(searchCond);
    }
  }

  const rows = await db
    .select({
      id: emails.id,
      batchId: emails.batchId,
      userId: emails.userId,
      senderId: emails.senderId,
      senderEmail: senders.email,
      recipientEmail: emails.recipientEmail,
      subject: emails.subject,
      body: emails.body,
      status: emails.status,
      scheduledAt: emails.scheduledAt,
      sentAt: emails.sentAt,
      etherealPreviewUrl: emails.etherealPreviewUrl,
      errorMessage: emails.errorMessage,
    })
    .from(emails)
    .innerJoin(senders, eq(emails.senderId, senders.id))
    .where(and(...conditions))
    .orderBy(desc(emails.scheduledAt))
    .limit(limit);

  return {
    engine: 'postgresql-fallback' as const,
    items: rows.map((row) => ({
      ...row,
      scheduledAt: row.scheduledAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    })),
    total: rows.length,
  };
}

export function getElasticsearchStatus() {
  return {
    configured: Boolean(env.elasticsearchUrl),
    connected: esReady,
    indexName: INDEX_NAME,
    lastError: esLastError,
  };
}
