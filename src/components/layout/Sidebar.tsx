import {
  Activity,
  CalendarClock,
  CheckCheck,
  PlugZap,
  X,
} from 'lucide-react';
import type { ActiveTab, SenderAccount } from '../../types/scheduler.ts';
import { OutboxlyLogo } from '../ui/OutboxlyLogo.tsx';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  senders: SenderAccount[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const navItems: Array<{
  id: ActiveTab;
  label: string;
  Icon: typeof CalendarClock;
}> = [
  { id: 'scheduled', label: 'Scheduled Emails', Icon: CalendarClock },
  { id: 'sent', label: 'Sent Emails', Icon: CheckCheck },
  { id: 'queue', label: 'Queue Monitor', Icon: Activity },
  { id: 'integrations', label: 'Senders & Slack', Icon: PlugZap },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  senders,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const content = (
    <div className="flex flex-col h-full bg-white border-r border-[#E2E8F0] w-60">
      <div className="flex items-center justify-between px-5 h-16 border-b border-[#E2E8F0]">
        <OutboxlyLogo size="sm" />
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden p-1 text-[#64748B] hover:text-[#0F172A] rounded"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main navigation">
        {navItems.map(({ id, label, Icon }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                onSelectTab(id);
                onCloseMobile();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-[#EFF6FF] text-[#1D4ED8]'
                  : 'text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-[#E2E8F0]">
        <p className="text-xs font-medium text-[#64748B]">Active Senders</p>
        <p className="mt-1 text-sm font-semibold text-[#0F172A] tabular-nums">
          {senders.length} {senders.length === 1 ? 'account' : 'accounts'}
        </p>
        {senders[0] && (
          <p className="mt-0.5 text-xs text-[#64748B] truncate" title={senders[0].email}>
            {senders[0].email}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0">{content}</aside>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden flex"
          onClick={(e) => {
            if (e.target === e.currentTarget) onCloseMobile();
          }}
        >
          <div className="fixed inset-0 bg-[#0F172A]/30" aria-hidden="true" />
          <div className="relative z-10">{content}</div>
        </div>
      )}
    </>
  );
}
