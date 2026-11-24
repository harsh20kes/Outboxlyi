import { LogOut, Menu, Plus } from 'lucide-react';
import type { ActiveTab, UserProfile } from '../../types/scheduler.ts';
import { Button } from '../ui/Button.tsx';

interface TopHeaderProps {
  activeTab: ActiveTab;
  profile: UserProfile;
  onOpenCompose: () => void;
  onLogout: () => void;
  onOpenMobileNav: () => void;
}

const tabTitles: Record<ActiveTab, string> = {
  scheduled: 'Scheduled Emails',
  sent: 'Sent Emails',
  queue: 'Queue Monitor',
  integrations: 'Senders & Slack',
};

export function TopHeader({
  activeTab,
  profile,
  onOpenCompose,
  onLogout,
  onOpenMobileNav,
}: TopHeaderProps) {
  const displayName = profile.name || profile.email.split('@')[0];
  const initials = displayName
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() || '')
    .slice(0, 2)
    .join('');

  return (
    <header className="h-16 bg-white border-b border-[#E2E8F0] px-4 sm:px-6 flex items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] rounded-md"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-[#64748B] hidden sm:inline">Workspace</span>
          <span className="text-[#CBD5E1] hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="font-semibold text-[#0F172A] truncate">
            {tabTitles[activeTab]}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <Button
          type="button"
          variant="primary"
          size="sm"
          icon={<Plus className="w-4 h-4" />}
          onClick={onOpenCompose}
        >
          Compose New Email
        </Button>

        <div className="hidden sm:block h-6 w-px bg-[#E2E8F0]" aria-hidden="true" />

        <div className="flex items-center gap-2.5">
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={displayName}
              referrerPolicy="no-referrer"
              className="w-8 h-8 rounded-full object-cover border border-[#E2E8F0]"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[#F1F5F9] border border-[#E2E8F0] text-[#334155] flex items-center justify-center text-xs font-semibold">
              {initials || 'U'}
            </div>
          )}
          <div className="hidden md:block leading-tight">
            <p className="text-xs font-semibold text-[#0F172A] max-w-[140px] truncate">
              {displayName}
            </p>
            <p className="text-xs text-[#64748B] max-w-[160px] truncate">
              {profile.email}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={<LogOut className="w-3.5 h-3.5" />}
          onClick={onLogout}
          aria-label="Logout"
        >
          <span className="hidden sm:inline">Logout</span>
        </Button>
      </div>
    </header>
  );
}
