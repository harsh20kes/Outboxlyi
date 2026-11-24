import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { fetchQueueTelemetry, rehydrateQueueJobs } from '../../lib/api.ts';
import type { QueueTelemetry, SystemStatus } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { useToast } from '../ui/Toast.tsx';

interface QueueMonitorViewProps {
  systemStatus: SystemStatus | null;
}

export function QueueMonitorView({ systemStatus }: QueueMonitorViewProps) {
  const { getIdToken } = useAuth();
  const { addToast } = useToast();

  const [telemetry, setTelemetry] = useState<QueueTelemetry | null>(null);
  const [loading, setLoading] = useState(true);
  const [rehydrating, setRehydrating] = useState(false);

  const loadTelemetry = useCallback(async () => {
    try {
      const token = await getIdToken();
      const data = await fetchQueueTelemetry(token);
      setTelemetry(data);
    } catch (err) {
      console.error('Failed to load queue telemetry:', err);
    } finally {
      setLoading(false);
    }
  }, [getIdToken]);

  useEffect(() => {
    void loadTelemetry();
    const timer = window.setInterval(() => {
      void loadTelemetry();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadTelemetry]);

  const handleRehydrate = async () => {
    setRehydrating(true);
    try {
      const token = await getIdToken();
      const res = await rehydrateQueueJobs(token);
      addToast({
        tone: 'success',
        title: 'Queue rehydration complete',
        message: `${res.rehydratedCount} pending job(s) synchronized from PostgreSQL into BullMQ.`,
      });
      await loadTelemetry();
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Rehydration failed',
        message: err instanceof Error ? err.message : 'Unable to rehydrate queue.',
      });
    } finally {
      setRehydrating(false);
    }
  };

  const redisConnected = telemetry?.redis.connected ?? systemStatus?.redis.connected ?? false;
  const esConnected = systemStatus?.elasticsearch.connected ?? false;

  return (
    <div className="space-y-6">
      {/* Actions & External Bull Board */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#0F172A]">
            Live BullMQ Queue & Rate-Limit Monitor
          </h2>
          <p className="mt-1 text-xs text-[#475569]">
            Auto-refreshes every 5 seconds · Engine:{' '}
            <strong className="text-[#15803D]">
              {redisConnected ? 'BullMQ + Redis' : 'PostgreSQL Persistent Scheduler'}
            </strong>
            {' · '}
            Search:{' '}
            <strong className="text-[#0F172A]">
              {esConnected ? 'Elasticsearch' : 'PostgreSQL'}
            </strong>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={rehydrating}
            disabled={!redisConnected}
            icon={<RotateCcw className="w-3.5 h-3.5" />}
            onClick={() => void handleRehydrate()}
          >
            Rehydrate DB Jobs
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={() => void loadTelemetry()}
          >
            Refresh
          </Button>
          <a
            href="/admin/queues"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#1D4ED8] hover:bg-[#1E40AF] rounded-md transition-colors whitespace-nowrap"
          >
            <span>Open BullMQ Board</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* Queue Job Counts */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          { label: 'Waiting', value: telemetry?.counts.waiting ?? 0 },
          { label: 'Delayed', value: telemetry?.counts.delayed ?? 0 },
          { label: 'Active', value: telemetry?.counts.active ?? 0 },
          { label: 'Completed', value: telemetry?.counts.completed ?? 0 },
          { label: 'Failed', value: telemetry?.counts.failed ?? 0 },
        ].map((metric) => (
          <div
            key={metric.label}
            className="bg-white border border-[#E2E8F0] rounded-lg p-4"
          >
            <p className="text-xs font-medium text-[#64748B]">{metric.label}</p>
            <p className="mt-1.5 text-2xl font-semibold text-[#0F172A] font-mono-tabular">
              {loading ? '—' : metric.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* Worker Config Summary */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-5">
        <h3 className="text-sm font-semibold text-[#0F172A]">
          Active Worker & Throttling Configuration
        </h3>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div className="p-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md">
            <p className="text-xs text-[#64748B]">Worker Concurrency</p>
            <p className="mt-1 text-base font-semibold text-[#0F172A] font-mono-tabular">
              {telemetry?.workerConcurrency ?? systemStatus?.defaults.workerConcurrency ?? 5} jobs
            </p>
          </div>
          <div className="p-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md">
            <p className="text-xs text-[#64748B]">Min Delay Between Sends</p>
            <p className="mt-1 text-base font-semibold text-[#0F172A] font-mono-tabular">
              {(
                (telemetry?.minDelayBetweenEmailsMs ??
                  systemStatus?.defaults.minDelayBetweenEmailsMs ??
                  2000) / 1000
              ).toFixed(1)}
              s
            </p>
          </div>
          <div className="p-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md">
            <p className="text-xs text-[#64748B]">Default Hourly Cap / Sender</p>
            <p className="mt-1 text-base font-semibold text-[#0F172A] font-mono-tabular">
              {telemetry?.maxEmailsPerHourPerSender ??
                systemStatus?.defaults.maxEmailsPerHourPerSender ??
                200}
              /hr
            </p>
          </div>
        </div>
      </div>

      {/* Per-Sender Hourly Usage */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#0F172A]">
              Per-Sender Hourly Quota
            </h3>
            <p className="text-xs text-[#64748B] font-mono-tabular mt-0.5">
              Window: {telemetry?.hourWindow || 'Current UTC Hour'}
            </p>
          </div>
        </div>

        {!telemetry || telemetry.senderUsage.length === 0 ? (
          <EmptyState
            icon={<RefreshCw className="w-5 h-5" />}
            title="No sender quotas to display"
            description="Provision or add an Ethereal sender in Senders & Slack to monitor hourly throughput."
          />
        ) : (
          <div className="divide-y divide-[#E2E8F0]">
            {telemetry.senderUsage.map((usage) => {
              const pct = Math.min(
                100,
                Math.round((usage.sentThisHour / Math.max(1, usage.hourlyLimit)) * 100)
              );
              const isNearLimit = pct >= 90;
              return (
                <div
                  key={usage.senderId}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#0F172A] truncate">
                      {usage.name}
                    </p>
                    <p className="text-xs text-[#64748B] truncate">
                      {usage.email}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 sm:w-72 shrink-0">
                    <div className="flex-1 h-2 bg-[#F1F5F9] rounded overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          isNearLimit ? 'bg-[#B45309]' : 'bg-[#1D4ED8]'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono-tabular text-[#0F172A] w-24 text-right">
                      {usage.sentThisHour} / {usage.hourlyLimit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rate Limit History */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E2E8F0]">
          <h3 className="text-sm font-semibold text-[#0F172A]">
            Recent Rate-Limit & Slack Alert Events
          </h3>
        </div>

        {!telemetry || telemetry.rateLimitLogs.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-[#64748B]">
            No hourly rate-limit events recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                  <th className="py-2.5 px-5">Sender</th>
                  <th className="py-2.5 px-4">Hour Window</th>
                  <th className="py-2.5 px-4">Hourly Limit</th>
                  <th className="py-2.5 px-4">Slack Alert</th>
                  <th className="py-2.5 px-5">Recorded At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {telemetry.rateLimitLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2.5 px-5 text-xs font-medium text-[#0F172A]">
                      {log.senderName} ({log.senderEmail})
                    </td>
                    <td className="py-2.5 px-4 text-xs font-mono-tabular text-[#475569]">
                      {log.hourWindow}
                    </td>
                    <td className="py-2.5 px-4 text-xs font-mono-tabular text-[#0F172A]">
                      {log.limitValue}/hr
                    </td>
                    <td className="py-2.5 px-4 text-xs">
                      <span
                        className={
                          log.slackNotified
                            ? 'text-[#15803D] font-medium'
                            : 'text-[#64748B]'
                        }
                      >
                        {log.slackNotified ? 'Delivered to Slack' : 'Skipped (Disconnected)'}
                      </span>
                    </td>
                    <td className="py-2.5 px-5 text-xs font-mono-tabular text-[#475569]">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
