import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { EmailStatus } from '../../types/scheduler.ts';

const statusConfig: Record<
  EmailStatus,
  { label: string; textClass: string; Icon: typeof Clock }
> = {
  scheduled: {
    label: 'Scheduled',
    textClass: 'text-[#1D4ED8]',
    Icon: Clock,
  },
  delayed: {
    label: 'Rate-Limited (Rescheduled)',
    textClass: 'text-[#B45309]',
    Icon: AlertTriangle,
  },
  processing: {
    label: 'Sending',
    textClass: 'text-[#0F172A]',
    Icon: Loader2,
  },
  sent: {
    label: 'Sent',
    textClass: 'text-[#15803D]',
    Icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    textClass: 'text-[#B91C1C]',
    Icon: XCircle,
  },
};

export function StatusLabel({ status }: { status: string }) {
  const cfg =
    statusConfig[(status as EmailStatus) || 'scheduled'] ?? statusConfig.scheduled;
  const Icon = cfg.Icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${cfg.textClass}`}
    >
      <Icon
        className={`w-3.5 h-3.5 shrink-0 ${
          status === 'processing' ? 'animate-spin' : ''
        }`}
      />
      <span>{cfg.label}</span>
    </span>
  );
}
