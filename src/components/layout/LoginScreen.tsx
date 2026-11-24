import { useEffect, useState, type FormEvent } from 'react';
import {
  CalendarClock,
  ExternalLink,
  Gauge,
  MailCheck,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { PendingSignupResult } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/Input.tsx';
import { OutboxlyLogo } from '../ui/OutboxlyLogo.tsx';

type AuthMode = 'signin' | 'signup';

export function LoginScreen() {
  const {
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    verifySignupEmail,
    resendVerificationEmail,
    authError,
    clearAuthError,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submittingEmail, setSubmittingEmail] = useState(false);
  const [signingInGoogle, setSigningInGoogle] = useState(false);

  const [pendingVerification, setPendingVerification] =
    useState<PendingSignupResult | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [resendingCode, setResendingCode] = useState(false);
  const [verifyingLink, setVerifyingLink] = useState(false);
  const [infoNotice, setInfoNotice] = useState<string | null>(null);

  // Auto-verify if user arrived via ?verifyToken=... link in verification email
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('verifyToken');
    if (!verifyToken) return;

    // Clean token from URL immediately
    params.delete('verifyToken');
    const qs = params.toString();
    const cleanUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);

    setMode('signup');
    setVerifyingLink(true);
    void verifySignupEmail({ token: verifyToken })
      .catch(() => {
        // authError is set by verifySignupEmail
      })
      .finally(() => {
        setVerifyingLink(false);
      });
  }, [verifySignupEmail]);

  const handleModeChange = (nextMode: AuthMode) => {
    setMode(nextMode);
    setPendingVerification(null);
    setVerificationCode('');
    setInfoNotice(null);
    clearAuthError();
  };

  const handleGoogleAuth = async () => {
    setSigningInGoogle(true);
    try {
      await signInWithGoogle();
    } catch {
      // authError state is displayed in UI
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittingEmail(true);
    setInfoNotice(null);
    try {
      if (mode === 'signup') {
        const result = await signUpWithEmail(name, email, password);
        setPendingVerification(result);
        setVerificationCode('');
        setInfoNotice(
          result.deliveryMode === 'smtp-live'
            ? `Verification email sent to ${result.email}. Enter the 6-digit code or click the link in your inbox.`
            : `Verification email generated for ${result.email}. Open the Ethereal preview below to read your 6-digit code (or configure System SMTP in Integrations after signing in for real inbox verification).`
        );
      } else {
        await signInWithEmail(email, password);
      }
    } catch {
      // authError state is displayed in UI
    } finally {
      setSubmittingEmail(false);
    }
  };

  const handleVerifyCodeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pendingVerification) return;
    setVerifyingCode(true);
    setInfoNotice(null);
    try {
      await verifySignupEmail({
        email: pendingVerification.email,
        code: verificationCode.trim(),
      });
    } catch {
      // authError state is displayed in UI
    } finally {
      setVerifyingCode(false);
    }
  };

  const handleResendCode = async () => {
    if (!pendingVerification) return;
    setResendingCode(true);
    setInfoNotice(null);
    try {
      const updated = await resendVerificationEmail(pendingVerification.email);
      setPendingVerification(updated);
      setInfoNotice(`A new verification code was sent to ${updated.email}.`);
    } catch {
      // authError state is displayed in UI
    } finally {
      setResendingCode(false);
    }
  };

  const showVerificationStep = mode === 'signup' && pendingVerification !== null;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between px-6 py-10">
      <div className="max-w-5xl w-full mx-auto flex items-center justify-between">
        <OutboxlyLogo size="md" />
        <span className="text-xs text-[#64748B]">
          Email Delivery Operations
        </span>
      </div>

      <main className="max-w-5xl w-full mx-auto my-12 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
        <div className="lg:col-span-7 space-y-6">
          <h1
            className="text-3xl sm:text-4xl font-semibold tracking-tight text-[#0F172A] leading-tight"
            style={{ textWrap: 'balance' }}
          >
            Schedule outbound email batches with deterministic rate limits.
          </h1>
          <p className="text-base text-[#475569] leading-relaxed max-w-xl">
            Enqueue CSV lead lists onto persistent BullMQ queues backed by
            PostgreSQL and Redis, enforce per-sender hourly caps, search logs
            across campaigns, and receive Slack notifications on limit events.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="p-4 bg-white border border-[#E2E8F0] rounded-lg">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                <CalendarClock className="w-4 h-4 text-[#1D4ED8]" />
                <span>Persistent Delayed Jobs</span>
              </div>
              <p className="mt-1.5 text-xs text-[#475569] leading-relaxed">
                BullMQ delayed scheduling with idempotent delivery state
                preserved across server restarts.
              </p>
            </div>

            <div className="p-4 bg-white border border-[#E2E8F0] rounded-lg">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                <Gauge className="w-4 h-4 text-[#1D4ED8]" />
                <span>Distributed Rate Control</span>
              </div>
              <p className="mt-1.5 text-xs text-[#475569] leading-relaxed">
                Atomic Redis hourly counters per sender automatically roll
                overflow jobs to the next window.
              </p>
            </div>

            <div className="p-4 bg-white border border-[#E2E8F0] rounded-lg">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                <MailCheck className="w-4 h-4 text-[#1D4ED8]" />
                <span>Live Gmail &amp; SMTP Delivery</span>
              </div>
              <p className="mt-1.5 text-xs text-[#475569] leading-relaxed">
                Send real outbound emails via Gmail or custom SMTP providers,
                plus Ethereal sandbox testing.
              </p>
            </div>

            <div className="p-4 bg-white border border-[#E2E8F0] rounded-lg">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                <ShieldCheck className="w-4 h-4 text-[#1D4ED8]" />
                <span>Verified Account Onboarding</span>
              </div>
              <p className="mt-1.5 text-xs text-[#475569] leading-relaxed">
                New email signups verify their inbox before registration
                completes, with Slack alerts for workspace events.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="bg-white border border-[#E2E8F0] rounded-lg p-7">
            {/* Sign In / Create Account mode switcher */}
            <div
              className="grid grid-cols-2 gap-1 p-1 bg-[#F1F5F9] rounded-md mb-5"
              role="tablist"
              aria-label="Authentication mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                onClick={() => handleModeChange('signin')}
                className={`py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  mode === 'signin'
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                onClick={() => handleModeChange('signup')}
                className={`py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  mode === 'signup'
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                Create Account
              </button>
            </div>

            <h2 className="text-lg font-semibold text-[#0F172A]">
              {showVerificationStep
                ? 'Verify your email address'
                : mode === 'signup'
                  ? 'Create your Outboxly account'
                  : 'Sign in to Outboxly'}
            </h2>
            <p className="mt-1 text-xs text-[#475569]">
              {showVerificationStep
                ? `Enter the 6-digit code sent to ${pendingVerification.email} to complete registration.`
                : mode === 'signup'
                  ? 'We will send a verification code to your email before creating your account.'
                  : 'Sign in with your account credentials or Google.'}
            </p>

            {verifyingLink && (
              <div className="mt-4 p-3 text-xs text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] rounded-md">
                Verifying your email link and completing registration...
              </div>
            )}

            {infoNotice && (
              <div className="mt-4 p-3 text-xs text-[#1E3A8A] bg-[#EFF6FF] border border-[#BFDBFE] rounded-md leading-relaxed">
                {infoNotice}
              </div>
            )}

            {authError && (
              <div
                role="alert"
                className="mt-4 p-3 text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-md"
              >
                {authError}
              </div>
            )}

            {showVerificationStep ? (
              <form onSubmit={handleVerifyCodeSubmit} className="mt-5 space-y-4">
                {pendingVerification.deliveryMode === 'ethereal-sandbox' &&
                  pendingVerification.previewUrl && (
                    <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-md text-xs text-[#92400E] space-y-2">
                      <p>
                        {pendingVerification.fallbackNotice ||
                          'System Live SMTP is not configured yet, so this verification message was captured in Ethereal sandbox.'}
                      </p>
                      <a
                        href={pendingVerification.previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-semibold text-[#1D4ED8] hover:underline"
                      >
                        <span>Open Verification Email (Ethereal)</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}

                <Input
                  label="6-Digit Verification Code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="123456"
                  value={verificationCode}
                  onChange={(e) =>
                    setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  required
                  autoComplete="one-time-code"
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={verifyingCode}
                  disabled={verificationCode.length !== 6 || resendingCode}
                  className="w-full"
                >
                  Verify &amp; Register Account
                </Button>

                <div className="flex items-center justify-between pt-2 text-xs">
                  <button
                    type="button"
                    disabled={resendingCode || verifyingCode}
                    onClick={() => void handleResendCode()}
                    className="font-medium text-[#1D4ED8] hover:underline cursor-pointer disabled:opacity-50"
                  >
                    {resendingCode ? 'Sending new code...' : 'Resend Code'}
                  </button>
                  <button
                    type="button"
                    disabled={verifyingCode}
                    onClick={() => {
                      setPendingVerification(null);
                      setVerificationCode('');
                      setInfoNotice(null);
                      clearAuthError();
                    }}
                    className="text-[#475569] hover:text-[#0F172A] cursor-pointer"
                  >
                    Use a different email
                  </button>
                </div>
              </form>
            ) : (
              <>
                <form onSubmit={handleEmailSubmit} className="mt-5 space-y-3.5">
                  {mode === 'signup' && (
                    <Input
                      label="Full Name"
                      type="text"
                      placeholder="Alex Rivera"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      autoComplete="name"
                    />
                  )}

                  <Input
                    label="Email Address"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />

                  <Input
                    label="Password"
                    type="password"
                    placeholder={
                      mode === 'signup'
                        ? 'Minimum 6 characters'
                        : 'Enter your password'
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete={
                      mode === 'signup' ? 'new-password' : 'current-password'
                    }
                  />

                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    loading={submittingEmail}
                    disabled={signingInGoogle || verifyingLink}
                    className="w-full"
                  >
                    {mode === 'signup' ? 'Send Verification Code' : 'Sign In'}
                  </Button>
                </form>

                <div className="my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[#E2E8F0]" />
                  <span className="text-xs text-[#64748B]">or</span>
                  <div className="h-px flex-1 bg-[#E2E8F0]" />
                </div>

                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  loading={signingInGoogle}
                  disabled={submittingEmail || verifyingLink}
                  onClick={handleGoogleAuth}
                  className="w-full"
                >
                  {!signingInGoogle && (
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        fill="currentColor"
                        d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z"
                      />
                    </svg>
                  )}
                  <span>
                    {mode === 'signup'
                      ? 'Sign up with Google'
                      : 'Continue with Google'}
                  </span>
                </Button>
              </>
            )}

            <p className="mt-4 text-xs text-[#64748B] leading-relaxed">
              Accounts are verified before activation, and all scheduled
              campaigns and sender credentials are isolated per user. If Google
              Sign-In shows a Testing Mode access block for an account, register
              or sign in with email &amp; password above.
            </p>
          </div>
        </div>
      </main>

      <footer className="max-w-5xl w-full mx-auto text-xs text-[#64748B] flex items-center justify-between border-t border-[#E2E8F0] pt-5">
        <span>Outboxly</span>
        <span>PostgreSQL · BullMQ · Gmail &amp; SMTP · Elasticsearch</span>
      </footer>
    </div>
  );
}
