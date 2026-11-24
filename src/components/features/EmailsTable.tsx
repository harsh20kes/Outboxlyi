import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MailCheck,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { fetchEmails, searchEmails } from '../../lib/api.ts';
import type { EmailRecord, SenderAccount } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { Modal } from '../ui/Modal.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { TableSkeleton } from '../ui/TableSkeleton.tsx';

interface EmailsTableProps {
  mode: 'scheduled' | 'sent';
  senders: SenderAccount[];
  refreshKey: number;
  onOpenCompose: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function EmailsTable({
  mode,
  senders,
  refreshKey,
  onOpenCompose,
}: EmailsTableProps) {
  const { getIdToken } = useAuth();

  const [items, setItems] = useState<EmailRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [statusFilter, setStatusFilter] = useState('');
  const [senderFilter, setSenderFilter] = useState<number | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchEngine, setSearchEngine] = useState<
    'elasticsearch' | 'postgresql-fallback' | null
  >(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<EmailRecord | null>(null);

  useEffect(() => {
    setPage(1);
    setStatusFilter('');
  }, [mode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const token = await getIdToken();
        if (debouncedSearch.length > 0 && !statusFilter && !senderFilter) {
          const res = await searchEmails(token, debouncedSearch, mode);
          setItems(res.items);
          setTotal(res.total);
          setSearchEngine(res.engine);
        } else {
          setSearchEngine(null);
          const res = await fetchEmails(token, {
            tab: mode,
            status: statusFilter || undefined,
            senderId: senderFilter,
            search: debouncedSearch || undefined,
            page,
            pageSize,
          });
          setItems(res.items);
          setTotal(res.total);
        }
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'Failed to load emails.');
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [getIdToken, mode, statusFilter, senderFilter, debouncedSearch, page]
  );

  useEffect(() => {
    void loadData(false);
  }, [loadData, refreshKey]);

  // Keep scheduled/sent tables fresh automatically without jarring skeleton flashes
  useEffect(() => {
    const intervalMs = mode === 'scheduled' ? 3000 : 5000;
    const timer = window.setInterval(() => {
      void loadData(true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [loadData, mode]);

  const filterButtons =
    mode === 'scheduled'
      ? [
          { value: '', label: 'All' },
          { value: 'scheduled', label: 'Scheduled' },
          { value: 'delayed', label: 'Rate-Limited' },
        ]
      : [
          { value: '', label: 'All' },
          { value: 'sent', label: 'Sent' },
          { value: 'failed', label: 'Failed' },
        ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search emails"
              placeholder="Search recipient, subject, or body..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-sm text-[#0F172A] bg-[#F8FAFC] border border-[#E2E8F0] rounded-md placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#1D4ED8]/20 focus:border-[#1D4ED8]"
            />
          </div>

          <div
            className="flex items-center gap-1 p-1 bg-[#F1F5F9] rounded-md"
            role="group"
            aria-label="Status filter"
          >
            {filterButtons.map((btn) => (
              <button
                key={btn.value || 'all'}
                type="button"
                onClick={() => {
                  setStatusFilter(btn.value);
                  setPage(1);
                }}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                  statusFilter === btn.value
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {senders.length > 1 && (
            <select
              aria-label="Filter by sender"
              value={senderFilter}
              onChange={(e) => {
                setSenderFilter(
                  e.target.value ? Number.parseInt(e.target.value, 10) : ''
                );
                setPage(1);
              }}
              className="px-3 py-1.5 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] rounded-md focus:outline-none focus:border-[#1D4ED8]"
            >
              <option value="">All Senders</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.email}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {searchEngine && (
            <span className="text-xs text-[#64748B]">
              Search:{' '}
              {searchEngine === 'elasticsearch'
                ? 'Elasticsearch'
                : 'PostgreSQL'}
            </span>
          )}
          <span className="text-xs text-[#64748B] tabular-nums">
            {total.toLocaleString()} {total === 1 ? 'email' : 'emails'}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={() => void loadData()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Table container */}
      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
        {error && (
          <div className="p-4 bg-[#FEF2F2] border-b border-[#FECACA] text-xs text-[#B91C1C]">
            {error}
          </div>
        )}

        {loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={
              mode === 'scheduled' ? (
                <CalendarClock className="w-5 h-5" />
              ) : (
                <MailCheck className="w-5 h-5" />
              )
            }
            title={
              debouncedSearch
                ? 'No matching emails found'
                : mode === 'scheduled'
                  ? 'No scheduled emails'
                  : 'No sent emails yet'
            }
            description={
              debouncedSearch
                ? `No emails matched "${debouncedSearch}". Try clearing the search filter.`
                : mode === 'scheduled'
                  ? 'Upload a CSV lead list and schedule your first outbound email campaign.'
                  : 'Delivered and failed email attempts will appear here once processed by the BullMQ worker.'
            }
            action={
              !debouncedSearch && mode === 'scheduled' ? (
                <Button type="button" variant="primary" onClick={onOpenCompose}>
                  Compose New Email
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                  <th className="py-3 px-5">Email</th>
                  <th className="py-3 px-4">Subject</th>
                  <th className="py-3 px-4">Sender</th>
                  <th className="py-3 px-4">
                    {mode === 'scheduled' ? 'Scheduled Time' : 'Sent Time'}
                  </th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-5 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] text-sm">
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-[#F8FAFC] transition-colors"
                  >
                    <td className="py-3 px-5 font-medium text-[#0F172A] max-w-[220px] truncate">
                      {item.recipientEmail}
                    </td>
                    <td className="py-3 px-4 text-[#334155] max-w-[260px] truncate">
                      {item.subject}
                    </td>
                    <td className="py-3 px-4 text-xs text-[#64748B] max-w-[180px] truncate">
                      {item.senderEmail}
                    </td>
                    <td className="py-3 px-4 text-xs text-[#475569] font-mono-tabular whitespace-nowrap">
                      {formatDateTime(
                        mode === 'scheduled' ? item.scheduledAt : item.sentAt || item.scheduledAt
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <StatusLabel status={item.status} />
                    </td>
                    <td className="py-3 px-5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-3">
                        {item.etherealPreviewUrl && (
                          <a
                            href={item.etherealPreviewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] hover:underline"
                          >
                            <span>Ethereal</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedEmail(item)}
                          className="text-xs font-medium text-[#475569] hover:text-[#0F172A] cursor-pointer"
                        >
                          View
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > pageSize && !debouncedSearch && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#E2E8F0] bg-[#F8FAFC] text-xs text-[#475569]">
            <span className="tabular-nums">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                icon={<ChevronLeft className="w-3.5 h-3.5" />}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Email Detail Modal */}
      <Modal
        open={Boolean(selectedEmail)}
        onClose={() => setSelectedEmail(null)}
        title={selectedEmail?.subject || 'Email Details'}
        subtitle={
          selectedEmail
            ? `To ${selectedEmail.recipientEmail} · From ${selectedEmail.senderEmail}`
            : undefined
        }
        maxWidthClass="max-w-xl"
      >
        {selectedEmail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 p-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-xs">
              <div>
                <p className="text-[#64748B]">Status</p>
                <div className="mt-1">
                  <StatusLabel status={selectedEmail.status} />
                </div>
              </div>
              <div>
                <p className="text-[#64748B]">
                  {selectedEmail.sentAt ? 'Sent At' : 'Scheduled At'}
                </p>
                <p className="mt-1 font-mono-tabular text-[#0F172A]">
                  {formatDateTime(selectedEmail.sentAt || selectedEmail.scheduledAt)}
                </p>
              </div>
            </div>

            {selectedEmail.errorMessage && (
              <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] rounded-md text-xs text-[#B91C1C]">
                <strong>Delivery Error:</strong> {selectedEmail.errorMessage}
              </div>
            )}

            {selectedEmail.status === 'sent' && !selectedEmail.etherealPreviewUrl && (
              <div className="p-3 bg-[#F0FDF4] border border-[#BBF7D0] rounded-md text-xs text-[#166534]">
                Dispatched directly to <strong>{selectedEmail.recipientEmail}</strong> via live delivery.
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-[#64748B] mb-1.5">
                Message Body
              </p>
              <pre className="p-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-xs text-[#0F172A] whitespace-pre-wrap font-sans leading-relaxed">
                {selectedEmail.body}
              </pre>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              {selectedEmail.etherealPreviewUrl && (
                <a
                  href={selectedEmail.etherealPreviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#1D4ED8] hover:bg-[#1E40AF] rounded-md"
                >
                  <span>Open Sandbox Preview</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setSelectedEmail(null)}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
