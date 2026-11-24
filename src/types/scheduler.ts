export interface SlackStatus {
  connected: boolean;
  configuredOnServer: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
  redirectUri: string;
}

export interface UserProfile {
  id: number;
  uid: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  slack: SlackStatus;
}

export type DeliveryMode = 'gmail-api' | 'smtp-live' | 'ethereal-sandbox';

export interface SenderAccount {
  id: number;
  name: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  etherealWebUrl: string | null;
  hourlyLimit: number | null;
  isDefault: boolean;
  deliveryMode: DeliveryMode;
  createdAt: string;
}

export type EmailStatus = 'scheduled' | 'delayed' | 'processing' | 'sent' | 'failed';

export interface EmailRecord {
  id: number;
  batchId: number;
  senderId: number;
  senderName?: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  etherealPreviewUrl: string | null;
  errorMessage: string | null;
  retryCount?: number;
  createdAt?: string;
}

export interface EmailsListResponse {
  items: EmailRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EmailSearchResponse {
  engine: 'elasticsearch' | 'postgresql-fallback';
  items: EmailRecord[];
  total: number;
}

export interface SystemStatus {
  redis: {
    configured: boolean;
    connected: boolean;
    lastError: string | null;
  };
  elasticsearch: {
    configured: boolean;
    connected: boolean;
    indexName: string;
    lastError: string | null;
  };
  slackConfigured: boolean;
  defaults: {
    workerConcurrency: number;
    minDelayBetweenEmailsMs: number;
    maxEmailsPerHourPerSender: number;
  };
}

export interface QueueTelemetry {
  redis: {
    configured: boolean;
    connected: boolean;
    lastError: string | null;
  };
  workerConcurrency: number;
  minDelayBetweenEmailsMs: number;
  maxEmailsPerHourPerSender: number;
  hourWindow: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused: number;
  };
  senderUsage: Array<{
    senderId: number;
    name: string;
    email: string;
    sentThisHour: number;
    hourlyLimit: number;
    hourWindow: string;
  }>;
  rateLimitLogs: Array<{
    id: number;
    senderId: number;
    senderEmail: string;
    senderName: string;
    hourWindow: string;
    limitValue: number;
    slackNotified: boolean;
    createdAt: string;
  }>;
  emailStatusCounts: Array<{
    status: string;
    count: number;
  }>;
}

export type ActiveTab = 'scheduled' | 'sent' | 'queue' | 'integrations';

export interface PendingSignupResult {
  pendingVerification: boolean;
  email: string;
  deliveryMode: 'smtp-live' | 'ethereal-sandbox';
  previewUrl: string | null;
  fallbackNotice?: string | null;
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

export interface GmailStatusResponse {
  connected: boolean;
  gmailEmail: string | null;
}

