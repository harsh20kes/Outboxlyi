import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { fetchSenders, fetchSystemStatus } from '../../lib/api.ts';
import type {
  ActiveTab,
  SenderAccount,
  SystemStatus,
} from '../../types/scheduler.ts';
import { ComposeModal } from '../features/ComposeModal.tsx';
import { EmailsTable } from '../features/EmailsTable.tsx';
import { IntegrationsView } from '../features/IntegrationsView.tsx';
import { QueueMonitorView } from '../features/QueueMonitorView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopHeader } from './TopHeader.tsx';

function readTabFromHash(): ActiveTab {
  const hash = window.location.hash.replace('#', '');
  if (
    hash === 'scheduled' ||
    hash === 'sent' ||
    hash === 'queue' ||
    hash === 'integrations'
  ) {
    return hash;
  }
  return 'scheduled';
}

export function WorkspaceShell() {
  const { profile, gmailConnected, logout, getIdToken } = useAuth();

  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromHash);
  const [composeOpen, setComposeOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [senders, setSenders] = useState<SenderAccount[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openAddSmtpNonce, setOpenAddSmtpNonce] = useState(0);

  const handleSelectTab = (tab: ActiveTab) => {
    setActiveTab(tab);
    window.location.hash = tab;
  };

  useEffect(() => {
    const onHashChange = () => setActiveTab(readTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const loadSenders = useCallback(async () => {
    try {
      const token = await getIdToken();
      const res = await fetchSenders(token);
      setSenders(res.senders);
    } catch (err) {
      console.error('Failed to fetch senders:', err);
    }
  }, [getIdToken]);

  const loadSystemStatus = useCallback(async () => {
    try {
      const token = await getIdToken();
      const status = await fetchSystemStatus(token);
      setSystemStatus(status);
    } catch (err) {
      console.error('Failed to fetch system status:', err);
    }
  }, [getIdToken]);

  useEffect(() => {
    void loadSenders();
    void loadSystemStatus();
  }, [loadSenders, loadSystemStatus, gmailConnected]);

  if (!profile) return null;

  const defaultDelaySeconds = Math.max(
    1,
    Math.round((systemStatus?.defaults.minDelayBetweenEmailsMs ?? 2000) / 1000)
  );
  const defaultHourlyLimit =
    systemStatus?.defaults.maxEmailsPerHourPerSender ?? 200;

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A]">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        senders={senders}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopHeader
          activeTab={activeTab}
          profile={profile}
          onOpenCompose={() => setComposeOpen(true)}
          onLogout={() => void logout()}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {(activeTab === 'scheduled' || activeTab === 'sent') && (
            <EmailsTable
              mode={activeTab}
              senders={senders}
              refreshKey={refreshKey}
              onOpenCompose={() => setComposeOpen(true)}
            />
          )}

          {activeTab === 'queue' && (
            <QueueMonitorView systemStatus={systemStatus} />
          )}

          {activeTab === 'integrations' && (
            <IntegrationsView
              senders={senders}
              onRefreshSenders={loadSenders}
              openAddSmtpNonce={openAddSmtpNonce}
            />
          )}
        </main>
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        senders={senders}
        defaultDelaySeconds={defaultDelaySeconds}
        defaultHourlyLimit={defaultHourlyLimit}
        onScheduled={() => {
          setRefreshKey((k) => k + 1);
          handleSelectTab('scheduled');
        }}
        onOpenIntegrations={() => {
          setOpenAddSmtpNonce((n) => n + 1);
          handleSelectTab('integrations');
        }}
        onRefreshSenders={loadSenders}
      />
    </div>
  );
}
