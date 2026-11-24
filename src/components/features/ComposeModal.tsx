import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Download,
  FileSpreadsheet,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { scheduleEmailBatch } from '../../lib/api.ts';
import { parseLeadsFile, type ParsedLeadsResult } from '../../lib/csvParser.ts';
import type { SenderAccount } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';
import { Input, Select, Textarea } from '../ui/Input.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  senders: SenderAccount[];
  defaultDelaySeconds: number;
  defaultHourlyLimit: number;
  onScheduled: () => void;
  onOpenIntegrations: () => void;
  onRefreshSenders: () => Promise<void>;
}

function getDefaultLocalDateTime(): string {
  const date = new Date(Date.now() + 60 * 1000);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatSenderLabel(s: SenderAccount): string {
  if (s.deliveryMode === 'gmail-api') {
    return `[Live Gmail] ${s.name} (${s.email})`;
  }
  if (s.deliveryMode === 'smtp-live') {
    return `[Live SMTP] ${s.name} (${s.email})`;
  }
  return `[Sandbox Only] ${s.name} (${s.email})`;
}

export function ComposeModal({
  open,
  onClose,
  senders,
  defaultDelaySeconds,
  defaultHourlyLimit,
  onScheduled,
  onOpenIntegrations,
  onRefreshSenders,
}: ComposeModalProps) {
  const {
    getIdToken,
    gmailConnected,
    connectGmail,
    getGmailAccessToken,
  } = useAuth();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [senderId, setSenderId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendTiming, setSendTiming] = useState<'now' | 'later'>('now');
  const [startTime, setStartTime] = useState(getDefaultLocalDateTime);
  const [delaySeconds, setDelaySeconds] = useState(String(defaultDelaySeconds));
  const [hourlyLimit, setHourlyLimit] = useState(String(defaultHourlyLimit));
  const [parsedLeads, setParsedLeads] = useState<ParsedLeadsResult | null>(null);
  const [manualEmails, setManualEmails] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reconnectingGmail, setReconnectingGmail] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmGmailOpen, setConfirmGmailOpen] = useState(false);
  const [batchKey, setBatchKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (open) {
      setSendTiming('now');
      setStartTime(getDefaultLocalDateTime());
      setDelaySeconds(String(defaultDelaySeconds));
      setHourlyLimit(String(defaultHourlyLimit));
      setBatchKey(crypto.randomUUID());
      setConfirmGmailOpen(false);
      if (senders.length > 0) {
        const currentExists = senders.some((s) => String(s.id) === senderId);
        if (!senderId || !currentExists) {
          const preferred =
            senders.find((s) => s.deliveryMode !== 'ethereal-sandbox' && s.isDefault) ??
            senders.find((s) => s.deliveryMode !== 'ethereal-sandbox') ??
            senders.find((s) => s.isDefault) ??
            senders[0];
          setSenderId(String(preferred.id));
        }
      }
    }
  }, [open, senders, senderId, defaultDelaySeconds, defaultHourlyLimit]);

  const selectedSender = senders.find((s) => String(s.id) === senderId) ?? null;

  const handleFile = async (file: File) => {
    setParseError(null);
    try {
      const result = await parseLeadsFile(file);
      if (result.validEmails.length === 0) {
        setParsedLeads(null);
        setParseError('No valid email addresses found in this file.');
        return;
      }
      setParsedLeads(result);
    } catch (err) {
      setParsedLeads(null);
      setParseError(
        err instanceof Error ? err.message : 'Unable to parse the uploaded file.'
      );
    }
  };

  const handleDownloadSampleCsv = () => {
    const csvContent =
      'email,first_name,company\nalice.morgan@example.com,Alice,Northwind\nbrian.chen@example.com,Brian,Contoso\nclaire.patel@example.com,Claire,Fabrikam\n';
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sample-leads.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const getCombinedRecipients = (): string[] => {
    const set = new Set<string>(parsedLeads?.validEmails ?? []);
    if (manualEmails.trim()) {
      const extra = manualEmails
        .split(/[\r\n,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      for (const email of extra) {
        set.add(email);
      }
    }
    return Array.from(set);
  };

  const recipients = getCombinedRecipients();

  const handleReconnectGmail = async () => {
    setReconnectingGmail(true);
    try {
      const { email } = await connectGmail();
      await onRefreshSenders();
      addToast({
        tone: 'success',
        title: 'Gmail connected',
        message: `${email} is authorized for live delivery.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Gmail connection failed',
        message: err instanceof Error ? err.message : 'Unable to connect Gmail.',
      });
    } finally {
      setReconnectingGmail(false);
    }
  };

  const effectiveStartTimeIso = () =>
    sendTiming === 'now'
      ? new Date().toISOString()
      : new Date(startTime).toISOString();

  const executeSchedule = async () => {
    if (!senderId || recipients.length === 0) return;

    setSubmitting(true);
    try {
      const token = await getIdToken();
      const gmailToken =
        selectedSender?.deliveryMode === 'gmail-api'
          ? getGmailAccessToken()
          : null;

      const isoStartTime = effectiveStartTimeIso();
      const result = await scheduleEmailBatch(
        token,
        {
          senderId: Number.parseInt(senderId, 10),
          subject,
          body,
          recipients,
          startTime: isoStartTime,
          delaySeconds: Number(delaySeconds) || defaultDelaySeconds,
          hourlyLimit: Number.parseInt(hourlyLimit, 10) || defaultHourlyLimit,
          batchKey,
        },
        gmailToken
      );

      addToast({
        tone: result.warning ? 'warning' : 'success',
        title:
          sendTiming === 'now'
            ? `Sending ${result.scheduledCount.toLocaleString()} email${
                result.scheduledCount === 1 ? '' : 's'
              }`
            : `${result.scheduledCount.toLocaleString()} email${
                result.scheduledCount === 1 ? '' : 's'
              } scheduled`,
        message:
          result.warning ||
          `Batch #${result.batchId} ${
            sendTiming === 'now'
              ? 'dispatched for immediate delivery.'
              : `queued starting ${new Date(isoStartTime).toLocaleString()}.`
          }`,
      });

      setSubject('');
      setBody('');
      setParsedLeads(null);
      setManualEmails('');
      setParseError(null);
      setConfirmGmailOpen(false);
      onScheduled();
      onClose();
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Scheduling failed',
        message:
          err instanceof Error ? err.message : 'Unable to schedule emails.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!senderId || !selectedSender) {
      addToast({
        tone: 'error',
        title: 'No sender selected',
        message: 'Connect Gmail or add a Live SMTP sender first.',
      });
      return;
    }
    if (recipients.length === 0) {
      addToast({
        tone: 'error',
        title: 'No recipients',
        message:
          'Upload a CSV/text file or enter at least one valid email address.',
      });
      return;
    }

    if (selectedSender.deliveryMode === 'gmail-api') {
      if (!gmailConnected && !getGmailAccessToken()) {
        addToast({
          tone: 'warning',
          title: 'Gmail authorization required',
          message: 'Click Reconnect Gmail below to authorize sending.',
        });
        return;
      }
      setConfirmGmailOpen(true);
      return;
    }

    await executeSchedule();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        confirmGmailOpen
          ? 'Confirm Real Email Delivery via Gmail'
          : 'Compose New Email Batch'
      }
      subtitle={
        confirmGmailOpen
          ? 'Review recipient details before sending through your Gmail account.'
          : 'Send immediately or schedule a throttled campaign with real Gmail/SMTP delivery.'
      }
      maxWidthClass="max-w-2xl"
    >
      {confirmGmailOpen && selectedSender ? (
        <div className="space-y-4">
          <div className="p-4 bg-[#EFF6FF] border border-[#BFDBFE] rounded-md text-xs text-[#1E3A8A] space-y-2">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>
                Send {recipients.length.toLocaleString()} real email
                {recipients.length === 1 ? '' : 's'} from {selectedSender.email}?
              </span>
            </div>
            <p>
              <strong>Subject:</strong> {subject}
            </p>
            <p>
              <strong>Recipients ({recipients.length.toLocaleString()}):</strong>{' '}
              {recipients.slice(0, 3).join(', ')}
              {recipients.length > 3
                ? `, and ${(recipients.length - 3).toLocaleString()} more`
                : ''}
            </p>
            <p>
              <strong>Delivery Timing:</strong>{' '}
              {sendTiming === 'now'
                ? 'Immediately'
                : new Date(startTime).toLocaleString()}
            </p>
          </div>

          <div className="flex justify-end gap-2.5 pt-2 border-t border-[#E2E8F0]">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmGmailOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={submitting}
              onClick={() => void executeSchedule()}
            >
              {sendTiming === 'now'
                ? 'Confirm & Send Now'
                : 'Confirm & Schedule Emails'}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Select
              label="Sender Account"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              required
              hint={
                selectedSender?.deliveryMode === 'ethereal-sandbox'
                  ? 'Sandbox Only'
                  : 'Real Inbox Delivery'
              }
            >
              {senders.length === 0 ? (
                <option value="">No sender accounts available</option>
              ) : (
                senders.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {formatSenderLabel(s)}
                  </option>
                ))
              )}
            </Select>

            {selectedSender?.deliveryMode === 'ethereal-sandbox' && (
              <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md text-xs text-[#92400E] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#B45309]" />
                  <span>
                    Ethereal is a test sandbox — messages will{' '}
                    <strong>not</strong> reach real recipient inboxes. Connect
                    Gmail or add a Live SMTP sender (Gmail App Password, Brevo,
                    Resend) for real delivery.
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={reconnectingGmail}
                    onClick={() => void handleReconnectGmail()}
                  >
                    Connect Gmail
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onClose();
                      onOpenIntegrations();
                    }}
                  >
                    Add Live SMTP
                  </Button>
                </div>
              </div>
            )}

            {selectedSender?.deliveryMode === 'gmail-api' &&
              !gmailConnected &&
              !getGmailAccessToken() && (
                <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md text-xs text-[#92400E] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span>
                    Your Gmail session authorization expired. Reconnect Gmail to
                    deliver messages to recipients&apos; inboxes.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    loading={reconnectingGmail}
                    onClick={() => void handleReconnectGmail()}
                  >
                    Reconnect Gmail
                  </Button>
                </div>
              )}
          </div>

          <Input
            label="Subject"
            placeholder="Q4 product partnership introduction"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={300}
          />

          <Textarea
            label="Email Body"
            placeholder="Write your plain-text email message..."
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-[#334155]">
                Lead List (CSV or Text File)
              </span>
              <button
                type="button"
                onClick={handleDownloadSampleCsv}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] hover:underline cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Sample CSV</span>
              </button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
              className={`border border-dashed rounded-md p-5 text-center transition-colors ${
                dragging
                  ? 'border-[#1D4ED8] bg-[#EFF6FF]'
                  : 'border-[#CBD5E1] bg-[#F8FAFC]'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />

              <div className="flex flex-col items-center gap-2">
                <div className="w-9 h-9 rounded-md bg-white border border-[#E2E8F0] flex items-center justify-center text-[#475569]">
                  {parsedLeads ? (
                    <FileSpreadsheet className="w-4 h-4 text-[#1D4ED8]" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                </div>

                {parsedLeads ? (
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[#0F172A]">
                      <span className="tabular-nums">
                        {parsedLeads.validEmails.length.toLocaleString()}
                      </span>{' '}
                      email address
                      {parsedLeads.validEmails.length === 1 ? '' : 'es'} detected
                    </p>
                    <p className="text-xs text-[#475569]">
                      {parsedLeads.fileName}
                      {parsedLeads.duplicateCount > 0 &&
                        ` · ${parsedLeads.duplicateCount} duplicate(s) skipped`}
                      {parsedLeads.invalidCount > 0 &&
                        ` · ${parsedLeads.invalidCount} invalid skipped`}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setParsedLeads(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      className="text-xs font-medium text-[#B91C1C] hover:underline cursor-pointer"
                    >
                      Remove file
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-[#334155]">
                      Drag and drop a <code>.csv</code> or <code>.txt</code>{' '}
                      file, or{' '}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="font-semibold text-[#1D4ED8] hover:underline cursor-pointer"
                      >
                        browse files
                      </button>
                    </p>
                    <p className="text-xs text-[#64748B]">
                      Up to 5 MB and 10,000 unique email addresses per batch.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {parseError && (
              <p className="mt-1.5 text-xs text-[#B91C1C]">{parseError}</p>
            )}
          </div>

          <Input
            label="Recipients (Email Addresses)"
            hint="Comma or newline separated"
            placeholder="receiver@example.com, lead2@company.com"
            value={manualEmails}
            onChange={(e) => setManualEmails(e.target.value)}
          />

          <div className="space-y-3 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[#334155]">
                Delivery Timing
              </span>
              <div
                className="inline-flex gap-1 p-1 bg-[#F1F5F9] rounded-md"
                role="group"
                aria-label="Delivery timing"
              >
                <button
                  type="button"
                  onClick={() => setSendTiming('now')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                    sendTiming === 'now'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#475569] hover:text-[#0F172A]'
                  }`}
                >
                  Send Now
                </button>
                <button
                  type="button"
                  onClick={() => setSendTiming('later')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                    sendTiming === 'later'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#475569] hover:text-[#0F172A]'
                  }`}
                >
                  Schedule Later
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {sendTiming === 'later' ? (
                <Input
                  label="Start Time"
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  required
                />
              ) : (
                <div className="flex flex-col justify-end pb-1">
                  <span className="text-xs font-medium text-[#334155] mb-1.5">
                    Start Time
                  </span>
                  <div className="px-3 py-2 text-xs font-medium text-[#15803D] bg-[#F0FDF4] border border-[#BBF7D0] rounded-md">
                    Immediate dispatch
                  </div>
                </div>
              )}
              <Input
                label="Delay Between Emails"
                hint="Seconds"
                type="number"
                min={1}
                max={3600}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(e.target.value)}
                required
              />
              <Input
                label="Hourly Limit"
                hint={`Max ${defaultHourlyLimit}/hr`}
                type="number"
                min={1}
                max={defaultHourlyLimit}
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 pt-4 border-t border-[#E2E8F0]">
            <p className="text-xs text-[#475569] tabular-nums">
              Total recipients ready:{' '}
              <strong className="text-[#0F172A]">
                {recipients.length.toLocaleString()}
              </strong>
            </p>
            <div className="flex items-center gap-2.5">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={submitting}
                disabled={recipients.length === 0 || senders.length === 0}
              >
                {sendTiming === 'now' ? 'Send Emails Now' : 'Schedule Emails'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
