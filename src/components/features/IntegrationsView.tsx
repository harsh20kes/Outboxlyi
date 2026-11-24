import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Mail,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import {
  clearSystemMailer,
  configureSystemMailer,
  createEtherealSender,
  createManualSender,
  deleteSender,
  disconnectSlack,
  fetchSystemMailerStatus,
  getSlackAuthUrl,
  sendSlackTestAlert,
  sendTestEmail,
} from '../../lib/api.ts';
import type { SenderAccount, SystemMailerStatus } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { Input } from '../ui/Input.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';

interface IntegrationsViewProps {
  senders: SenderAccount[];
  onRefreshSenders: () => Promise<void>;
  openAddSmtpNonce?: number;
}

type SmtpPresetId =
  | 'gmail-smtp'
  | 'brevo'
  | 'resend'
  | 'sendgrid'
  | 'outlook'
  | 'custom';

const SMTP_PRESETS: Array<{
  id: SmtpPresetId;
  label: string;
  host: string;
  port: string;
  userPlaceholder: string;
  passLabel: string;
  note: string;
}> = [
  {
    id: 'gmail-smtp',
    label: 'Gmail (App Password)',
    host: 'smtp.gmail.com',
    port: '465',
    userPlaceholder: 'you@gmail.com',
    passLabel: '16-Character Gmail App Password',
    note: 'Recommended for scheduled future batches and verification emails: enable 2-Step Verification in your Google Account, create an App Password, and enter it below.',
  },
  {
    id: 'brevo',
    label: 'Brevo',
    host: 'smtp-relay.brevo.com',
    port: '587',
    userPlaceholder: 'your-brevo-login@smtp-brevo.com',
    passLabel: 'Brevo SMTP Key',
    note: 'Use your Brevo SMTP login and SMTP key from Transactional > Settings > SMTP & API.',
  },
  {
    id: 'resend',
    label: 'Resend',
    host: 'smtp.resend.com',
    port: '465',
    userPlaceholder: 'resend',
    passLabel: 'Resend API Key (re_...)',
    note: 'Set SMTP Username to "resend" and paste your Resend API key as the password. From Email must match a verified domain.',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: '587',
    userPlaceholder: 'apikey',
    passLabel: 'SendGrid API Key (SG....)',
    note: 'Set SMTP Username to literally "apikey" and paste your SendGrid API key as the password.',
  },
  {
    id: 'outlook',
    label: 'Outlook / M365',
    host: 'smtp.office365.com',
    port: '587',
    userPlaceholder: 'you@outlook.com',
    passLabel: 'SMTP Password / App Password',
    note: 'Ensure Authenticated SMTP is enabled for your Microsoft 365 mailbox.',
  },
  {
    id: 'custom',
    label: 'Custom SMTP',
    host: '',
    port: '587',
    userPlaceholder: 'smtp-user@yourdomain.com',
    passLabel: 'SMTP Password',
    note: 'Connect any standard SMTP relay over SSL (465) or STARTTLS (587). Outboxly verifies credentials before saving.',
  },
];

export function IntegrationsView({
  senders,
  onRefreshSenders,
  openAddSmtpNonce = 0,
}: IntegrationsViewProps) {
  const {
    profile,
    gmailConnected,
    gmailEmail,
    connectGmail,
    getGmailAccessToken,
    getIdToken,
    refreshProfile,
  } = useAuth();
  const { addToast } = useToast();

  const [connectingGmail, setConnectingGmail] = useState(false);
  const [connectingSlack, setConnectingSlack] = useState(false);
  const [testingSlack, setTestingSlack] = useState(false);
  const [disconnectingSlack, setDisconnectingSlack] = useState(false);

  const [provisioningEthereal, setProvisioningEthereal] = useState(false);
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<SmtpPresetId>('gmail-smtp');

  const [systemMailer, setSystemMailer] = useState<SystemMailerStatus | null>(null);
  const [configuringSystemId, setConfiguringSystemId] = useState<number | null>(null);
  const [clearingSystemMailer, setClearingSystemMailer] = useState(false);

  const [testSender, setTestSender] = useState<SenderAccount | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [confirmGmailTestOpen, setConfirmGmailTestOpen] = useState(false);

  const [manualForm, setManualForm] = useState({
    name: '',
    email: '',
    smtpHost: 'smtp.gmail.com',
    smtpPort: '465',
    smtpUser: '',
    smtpPass: '',
    hourlyLimit: '100',
    useForSignup: false,
  });

  const loadSystemMailer = useCallback(async () => {
    try {
      const token = await getIdToken();
      const status = await fetchSystemMailerStatus(token);
      setSystemMailer(status);
    } catch (err) {
      console.error('Failed to fetch system mailer status:', err);
    }
  }, [getIdToken]);

  useEffect(() => {
    void loadSystemMailer();
  }, [loadSystemMailer]);

  const openLiveSmtpModal = useCallback(
    (useForSignup = false) => {
      setSelectedPreset('gmail-smtp');
      setManualForm({
        name: profile?.name || 'Outboxly Sender',
        email: profile?.email || '',
        smtpHost: 'smtp.gmail.com',
        smtpPort: '465',
        smtpUser: profile?.email || '',
        smtpPass: '',
        hourlyLimit: '100',
        useForSignup,
      });
      setManualModalOpen(true);
    },
    [profile?.email, profile?.name]
  );

  useEffect(() => {
    if (openAddSmtpNonce > 0) {
      openLiveSmtpModal(false);
    }
  }, [openAddSmtpNonce, openLiveSmtpModal]);

  // Listen for OAuth completion message from Slack popup window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost') &&
        origin !== window.location.origin
      ) {
        return;
      }

      if (event.data?.type === 'SLACK_OAUTH_SUCCESS') {
        void refreshProfile();
        addToast({
          tone: 'success',
          title: 'Slack connected',
          message: `Rate-limit notifications enabled for ${
            event.data.teamName || 'your workspace'
          }${event.data.channelName ? ` (#${event.data.channelName})` : ''}.`,
        });
      } else if (event.data?.type === 'SLACK_OAUTH_ERROR') {
        addToast({
          tone: 'error',
          title: 'Slack authorization cancelled',
          message: String(event.data.error || 'Authorization was declined.'),
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refreshProfile, addToast]);

  const handleConnectGmail = async () => {
    setConnectingGmail(true);
    try {
      const { email } = await connectGmail();
      await onRefreshSenders();
      addToast({
        tone: 'success',
        title: 'Gmail connected for real delivery',
        message: `${email} is ready to send emails directly to recipients' inboxes.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Gmail connection failed',
        message:
          err instanceof Error ? err.message : 'Unable to connect Gmail.',
      });
    } finally {
      setConnectingGmail(false);
    }
  };

  const handleSelectPreset = (presetId: SmtpPresetId) => {
    setSelectedPreset(presetId);
    const preset = SMTP_PRESETS.find((p) => p.id === presetId)!;
    setManualForm((prev) => ({
      ...prev,
      smtpHost: preset.host,
      smtpPort: preset.port,
      smtpUser:
        presetId === 'resend'
          ? 'resend'
          : presetId === 'sendgrid'
            ? 'apikey'
            : presetId === 'gmail-smtp'
              ? profile?.email || prev.email || ''
              : '',
      email:
        presetId === 'gmail-smtp'
          ? profile?.email || prev.email
          : prev.email,
      name:
        presetId === 'gmail-smtp' && !prev.name
          ? profile?.name || 'Gmail SMTP Sender'
          : prev.name,
    }));
  };

  const handleSetSenderAsSystemMailer = async (senderId: number) => {
    setConfiguringSystemId(senderId);
    try {
      const token = await getIdToken();
      const updated = await configureSystemMailer(token, { senderId });
      setSystemMailer(updated);
      addToast({
        tone: 'success',
        title: 'Signup verification mailer updated',
        message: `New user verification emails will now be delivered via ${updated.fromEmail}.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Could not update signup mailer',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to configure system verification mailer.',
      });
    } finally {
      setConfiguringSystemId(null);
    }
  };

  const handleClearSystemMailer = async () => {
    setClearingSystemMailer(true);
    try {
      const token = await getIdToken();
      const updated = await clearSystemMailer(token);
      setSystemMailer(updated);
      addToast({
        tone: 'info',
        title: 'Custom signup mailer cleared',
        message: 'Signup verification emails reverted to server defaults.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Action failed',
        message:
          err instanceof Error ? err.message : 'Unable to clear signup mailer.',
      });
    } finally {
      setClearingSystemMailer(false);
    }
  };

  const handleConnectSlack = async () => {
    setConnectingSlack(true);
    try {
      const token = await getIdToken();
      const { url } = await getSlackAuthUrl(token);
      const popup = window.open(
        url,
        'slack_oauth_popup',
        'width=600,height=720'
      );
      if (!popup) {
        addToast({
          tone: 'warning',
          title: 'Popup blocked',
          message: 'Please allow popups for this site to authorize Slack.',
        });
      }
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Slack OAuth unavailable',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to initiate Slack OAuth.',
      });
    } finally {
      setConnectingSlack(false);
    }
  };

  const handleTestSlack = async () => {
    setTestingSlack(true);
    try {
      const token = await getIdToken();
      await sendSlackTestAlert(token);
      addToast({
        tone: 'success',
        title: 'Slack test message sent',
        message: 'Check your connected Slack channel.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Test alert failed',
        message:
          err instanceof Error ? err.message : 'Unable to reach Slack.',
      });
    } finally {
      setTestingSlack(false);
    }
  };

  const handleDisconnectSlack = async () => {
    setDisconnectingSlack(true);
    try {
      const token = await getIdToken();
      await disconnectSlack(token);
      await refreshProfile();
      addToast({
        tone: 'info',
        title: 'Slack disconnected',
        message: 'Rate-limit alerts paused until you reconnect.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Disconnect failed',
        message:
          err instanceof Error ? err.message : 'Could not disconnect Slack.',
      });
    } finally {
      setDisconnectingSlack(false);
    }
  };

  const handleProvisionEthereal = async () => {
    setProvisioningEthereal(true);
    try {
      const token = await getIdToken();
      const res = await createEtherealSender(token, {});
      await onRefreshSenders();
      addToast({
        tone: 'info',
        title: 'Ethereal sandbox sender added',
        message: `Created ${res.sender.email} (captures previews only, does not deliver to real inboxes).`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Provisioning failed',
        message:
          err instanceof Error
            ? err.message
            : 'Could not create Ethereal account.',
      });
    } finally {
      setProvisioningEthereal(false);
    }
  };

  const handleCreateManualSender = async (e: FormEvent) => {
    e.preventDefault();
    setSavingManual(true);
    try {
      const token = await getIdToken();
      const created = await createManualSender(token, {
        name: manualForm.name,
        email: manualForm.email,
        smtpHost: manualForm.smtpHost,
        smtpPort: Number.parseInt(manualForm.smtpPort, 10) || 587,
        smtpUser: manualForm.smtpUser,
        smtpPass: manualForm.smtpPass,
        hourlyLimit: Number.parseInt(manualForm.hourlyLimit, 10) || 100,
      });
      await onRefreshSenders();

      if (manualForm.useForSignup && created.sender.deliveryMode === 'smtp-live') {
        try {
          const updatedMailer = await configureSystemMailer(token, {
            senderId: created.sender.id,
          });
          setSystemMailer(updatedMailer);
        } catch (sysErr) {
          addToast({
            tone: 'warning',
            title: 'Sender saved, signup relay skipped',
            message:
              sysErr instanceof Error
                ? sysErr.message
                : 'Only the workspace owner can set the signup verification mailer.',
          });
        }
      }

      setManualModalOpen(false);
      setManualForm({
        name: '',
        email: '',
        smtpHost: 'smtp.gmail.com',
        smtpPort: '465',
        smtpUser: '',
        smtpPass: '',
        hourlyLimit: '100',
        useForSignup: false,
      });
      setSelectedPreset('gmail-smtp');
      addToast({
        tone: 'success',
        title: 'Live SMTP sender verified & saved',
        message: 'SMTP credentials connected cleanly and ready for real delivery.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'SMTP verification failed',
        message:
          err instanceof Error ? err.message : 'Check SMTP credentials.',
      });
    } finally {
      setSavingManual(false);
    }
  };

  const handleDeleteSender = async (id: number) => {
    setDeletingId(id);
    try {
      const token = await getIdToken();
      await deleteSender(token, id);
      await onRefreshSenders();
      addToast({
        tone: 'info',
        title: 'Sender removed',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Remove failed',
        message:
          err instanceof Error ? err.message : 'Unable to delete sender.',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const executeTestEmailSend = async () => {
    if (!testSender) return;
    setSendingTest(true);
    try {
      const token = await getIdToken();
      const gmailToken =
        testSender.deliveryMode === 'gmail-api' ? getGmailAccessToken() : null;

      const result = await sendTestEmail(
        token,
        testSender.id,
        { to: testRecipient.trim() },
        gmailToken
      );

      setConfirmGmailTestOpen(false);
      setTestSender(null);
      addToast({
        tone: 'success',
        title:
          result.deliveryMode === 'ethereal-sandbox'
            ? 'Test message captured in Ethereal sandbox'
            : 'Real test email sent',
        message:
          result.deliveryMode === 'ethereal-sandbox'
            ? `Captured by Ethereal for ${testRecipient.trim()}.`
            : `Delivered to ${testRecipient.trim()}. Check the recipient inbox (or Spam if first message).`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Test email failed',
        message:
          err instanceof Error ? err.message : 'Unable to deliver test email.',
      });
    } finally {
      setSendingTest(false);
    }
  };

  const handleSubmitTestEmail = (e: FormEvent) => {
    e.preventDefault();
    if (!testSender || !testRecipient.trim()) return;
    if (testSender.deliveryMode === 'gmail-api') {
      if (!gmailConnected && !getGmailAccessToken()) {
        addToast({
          tone: 'warning',
          title: 'Gmail authorization required',
          message: 'Click Connect Gmail above before sending via Gmail API.',
        });
        return;
      }
      setConfirmGmailTestOpen(true);
      return;
    }
    void executeTestEmailSend();
  };

  const slack = profile?.slack;
  const activePreset =
    SMTP_PRESETS.find((p) => p.id === selectedPreset) ?? SMTP_PRESETS[0];

  return (
    <div className="space-y-6">
      {/* Gmail Direct Delivery Card */}
      <section className="bg-white border border-[#E2E8F0] rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-[#1D4ED8]" />
              <h2 className="text-base font-semibold text-[#0F172A]">
                Gmail Direct Delivery (Google Workspace)
              </h2>
            </div>
            <p className="text-sm text-[#475569] max-w-2xl">
              Connect your Gmail account to send real emails directly to
              recipients&apos; inboxes without configuring an SMTP server. For
              unattended batches scheduled more than 50 minutes ahead, add a
              Gmail App Password or SMTP relay below.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button
              type="button"
              variant={gmailConnected ? 'secondary' : 'primary'}
              size="sm"
              loading={connectingGmail}
              onClick={() => void handleConnectGmail()}
            >
              {gmailConnected ? 'Reconnect Gmail' : 'Connect Gmail'}
            </Button>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          {gmailConnected ? (
            <div className="flex items-center gap-2 text-[#15803D] font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                Gmail send access active for {gmailEmail || 'your Google account'}
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-[#64748B]">
              <AlertTriangle className="w-4 h-4 text-[#B45309] shrink-0 mt-0.5" />
              <span>
                Gmail direct send is not active in this session. Click Connect
                Gmail to authorize real inbox delivery (if Google shows a 403
                Testing Mode notice for an institutional/other account, add that
                email under Test Users in Google Cloud Console or use{' '}
                <button
                  type="button"
                  onClick={() => openLiveSmtpModal(false)}
                  className="font-medium text-[#1D4ED8] hover:underline cursor-pointer"
                >
                  Add Live SMTP → Gmail App Password
                </button>
                ).
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Senders Management Card */}
      <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-6 py-5 border-b border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#0F172A]">
              Email Sender Accounts
            </h2>
            <p className="mt-1 text-xs text-[#475569]">
              Use Gmail or Live SMTP senders for real inbox delivery. Ethereal
              accounts only capture test previews.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={provisioningEthereal}
              onClick={() => void handleProvisionEthereal()}
            >
              Add Sandbox Sender
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => openLiveSmtpModal(false)}
            >
              Add Live SMTP
            </Button>
          </div>
        </div>

        {senders.length === 0 ? (
          <EmptyState
            icon={<Mail className="w-5 h-5" />}
            title="No sender accounts configured"
            description="Connect Gmail above or add a Live SMTP sender (Gmail App Password, Brevo, Resend, SendGrid) to start delivering real emails."
            action={
              <Button
                type="button"
                variant="primary"
                onClick={() => setManualModalOpen(true)}
              >
                Add Live SMTP Sender
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                  <th className="py-3 px-6">Sender Name</th>
                  <th className="py-3 px-4">From Email</th>
                  <th className="py-3 px-4">Delivery Mode</th>
                  <th className="py-3 px-4">Hourly Limit</th>
                  <th className="py-3 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {senders.map((s) => {
                  const isActiveSystemMailer =
                    systemMailer?.configured &&
                    systemMailer.fromEmail === s.email &&
                    systemMailer.smtpHost === s.smtpHost;

                  return (
                    <tr key={s.id} className="hover:bg-[#F8FAFC]">
                      <td className="py-3 px-6 font-medium text-[#0F172A]">
                        {s.name}
                        {s.isDefault && (
                          <span className="ml-2 text-xs font-normal text-[#1D4ED8]">
                            Default
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs text-[#334155] font-mono-tabular">
                        {s.email}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {s.deliveryMode === 'gmail-api' ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-[#15803D]">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>Live Gmail API</span>
                          </span>
                        ) : s.deliveryMode === 'smtp-live' ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-[#15803D]">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>
                              Live SMTP ({s.smtpHost}:{s.smtpPort})
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 font-medium text-[#B45309]">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Sandbox Only (No Real Delivery)</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono-tabular text-[#0F172A]">
                        {s.hourlyLimit ?? 200}/hr
                      </td>
                      <td className="py-3 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-3">
                          {s.deliveryMode === 'smtp-live' &&
                            (isActiveSystemMailer ? (
                              <span className="text-xs font-medium text-[#15803D]">
                                Active Signup Mailer
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={configuringSystemId === s.id}
                                onClick={() => void handleSetSenderAsSystemMailer(s.id)}
                                className="text-xs font-medium text-[#334155] hover:text-[#1D4ED8] hover:underline cursor-pointer disabled:opacity-50"
                              >
                                {configuringSystemId === s.id
                                  ? 'Saving...'
                                  : 'Use for Signup Mail'}
                              </button>
                            ))}
                          <button
                            type="button"
                            onClick={() => {
                              setTestSender(s);
                              setTestRecipient(profile?.email || '');
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] hover:underline cursor-pointer"
                          >
                            <Send className="w-3 h-3" />
                            <span>Send Test</span>
                          </button>
                          {s.etherealWebUrl && (
                            <a
                              href={s.etherealWebUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-[#475569] hover:text-[#0F172A] hover:underline"
                            >
                              <span>Sandbox</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <button
                            type="button"
                            disabled={deletingId === s.id}
                            onClick={() => void handleDeleteSender(s.id)}
                            aria-label={`Delete ${s.email}`}
                            className="p-1 text-[#64748B] hover:text-[#B91C1C] rounded cursor-pointer disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Signup Verification Mailer Card */}
      <section className="bg-white border border-[#E2E8F0] rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#1D4ED8]" />
              <h2 className="text-base font-semibold text-[#0F172A]">
                Signup Verification Mailer
              </h2>
            </div>
            <p className="text-sm text-[#475569] max-w-2xl">
              New email signups require a 6-digit verification code before
              registration completes. Add a Live SMTP sender above (such as
              Gmail App Password, Brevo, or Resend) and click{' '}
              <strong>Use for Signup Mail</strong> so verification emails reach
              real user inboxes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {systemMailer?.source === 'database' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={clearingSystemMailer}
                onClick={() => void handleClearSystemMailer()}
              >
                Reset to Default
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setManualForm((f) => ({ ...f, useForSignup: true }));
                setManualModalOpen(true);
              }}
            >
              Configure Signup SMTP
            </Button>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          {systemMailer?.configured ? (
            <div className="flex items-center gap-2 text-[#15803D] font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                Live verification emails active via {systemMailer.fromEmail} (
                {systemMailer.smtpHost}:{systemMailer.smtpPort})
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[#B45309] font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                {systemMailer?.warning ||
                  'Using Ethereal sandbox fallback for signup verification previews. Set a Live SMTP sender above to deliver verification codes to real inboxes.'}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Slack Integration Card */}
      <section className="bg-white border border-[#E2E8F0] rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[#1D4ED8]" />
              <h2 className="text-base font-semibold text-[#0F172A]">
                Slack Rate-Limit Notifications
              </h2>
            </div>
            <p className="text-sm text-[#475569] max-w-2xl">
              Connect a Slack channel via OAuth to receive immediate alerts
              whenever any sender reaches its hourly email limit and overflow
              jobs reschedule to the next window.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {slack?.connected ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={testingSlack}
                  icon={<Send className="w-3.5 h-3.5" />}
                  onClick={() => void handleTestSlack()}
                >
                  Send Test Alert
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  loading={disconnectingSlack}
                  icon={<Unplug className="w-3.5 h-3.5" />}
                  onClick={() => void handleDisconnectSlack()}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={connectingSlack}
                onClick={() => void handleConnectSlack()}
              >
                Connect Slack
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          {slack?.connected ? (
            <div className="flex items-center gap-2 text-[#15803D] font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                Connected to {slack.teamName || 'Slack Workspace'}
                {slack.channelName ? ` (#${slack.channelName})` : ''}
              </span>
            </div>
          ) : (
            <span className="text-[#64748B]">
              Status: Not connected. Rate-limit events will be logged without
              sending Slack alerts.
            </span>
          )}

          {slack?.redirectUri && (
            <span className="text-[#64748B] font-mono-tabular truncate">
              OAuth Callback: {slack.redirectUri}
            </span>
          )}
        </div>
      </section>

      {/* Add Live SMTP Modal */}
      <Modal
        open={manualModalOpen}
        onClose={() => setManualModalOpen(false)}
        title="Add Live SMTP Sender"
        subtitle="Connect Gmail (App Password), Brevo, Resend, SendGrid, Outlook, or any custom SMTP server for real inbox delivery."
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleCreateManualSender} className="space-y-4">
          <div>
            <span className="block text-xs font-medium text-[#334155] mb-2">
              Provider Preset
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {SMTP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleSelectPreset(preset.id)}
                  className={`px-3 py-2 text-xs font-medium rounded-md border text-left transition-colors cursor-pointer ${
                    selectedPreset === preset.id
                      ? 'border-[#1D4ED8] bg-[#EFF6FF] text-[#1D4ED8]'
                      : 'border-[#E2E8F0] bg-white text-[#334155] hover:bg-[#F8FAFC]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="mt-2 p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-xs text-[#475569] leading-relaxed">
              {activePreset.note}
            </p>
          </div>

          <Input
            label="Sender Display Name"
            placeholder="Harsh Keshari"
            value={manualForm.name}
            onChange={(e) =>
              setManualForm((f) => ({ ...f, name: e.target.value }))
            }
            required
          />
          <Input
            label="From Email Address"
            type="email"
            placeholder="you@gmail.com"
            value={manualForm.email}
            onChange={(e) =>
              setManualForm((f) => ({ ...f, email: e.target.value }))
            }
            required
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label="SMTP Host"
                placeholder="smtp.gmail.com"
                value={manualForm.smtpHost}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, smtpHost: e.target.value }))
                }
                required
              />
            </div>
            <Input
              label="Port"
              type="number"
              value={manualForm.smtpPort}
              onChange={(e) =>
                setManualForm((f) => ({ ...f, smtpPort: e.target.value }))
              }
              required
            />
          </div>
          <Input
            label="SMTP Username"
            placeholder={activePreset.userPlaceholder}
            value={manualForm.smtpUser}
            onChange={(e) =>
              setManualForm((f) => ({ ...f, smtpUser: e.target.value }))
            }
            required
          />
          <Input
            label={activePreset.passLabel}
            type="password"
            value={manualForm.smtpPass}
            onChange={(e) =>
              setManualForm((f) => ({ ...f, smtpPass: e.target.value }))
            }
            required
          />
          <Input
            label="Sender Hourly Limit"
            type="number"
            min={1}
            value={manualForm.hourlyLimit}
            onChange={(e) =>
              setManualForm((f) => ({ ...f, hourlyLimit: e.target.value }))
            }
            required
          />

          <label className="flex items-start gap-2.5 p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-xs text-[#334155] cursor-pointer">
            <input
              type="checkbox"
              checked={manualForm.useForSignup}
              onChange={(e) =>
                setManualForm((f) => ({ ...f, useForSignup: e.target.checked }))
              }
              className="mt-0.5 rounded border-[#CBD5E1] text-[#1D4ED8] focus:ring-[#1D4ED8]"
            />
            <span>
              Also use this Live SMTP server to send signup verification emails
              to new users&apos; real inboxes.
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-[#E2E8F0]">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setManualModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={savingManual}>
              Verify &amp; Save Sender
            </Button>
          </div>
        </form>
      </Modal>

      {/* Send Test Email Modal */}
      <Modal
        open={Boolean(testSender)}
        onClose={() => {
          setTestSender(null);
          setConfirmGmailTestOpen(false);
        }}
        title="Send Test Email"
        subtitle={
          testSender
            ? `Verify delivery from ${testSender.email} (${
                testSender.deliveryMode === 'ethereal-sandbox'
                  ? 'Sandbox Preview Only'
                  : 'Live Inbox Delivery'
              })`
            : undefined
        }
        maxWidthClass="max-w-md"
      >
        {confirmGmailTestOpen && testSender ? (
          <div className="space-y-4">
            <div className="p-3.5 bg-[#EFF6FF] border border-[#BFDBFE] rounded-md text-xs text-[#1E3A8A] space-y-1.5">
              <p className="font-semibold">Confirm Gmail Send</p>
              <p>
                Are you sure you want to send a real email from{' '}
                <strong>{testSender.email}</strong> to{' '}
                <strong>{testRecipient.trim()}</strong>?
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirmGmailTestOpen(false)}
                disabled={sendingTest}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={sendingTest}
                onClick={() => void executeTestEmailSend()}
              >
                Confirm &amp; Send
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmitTestEmail} className="space-y-4">
            <Input
              label="Recipient Email"
              type="email"
              placeholder="receiver@example.com"
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value)}
              required
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-[#E2E8F0]">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTestSender(null)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={sendingTest}>
                Send Test Email
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
