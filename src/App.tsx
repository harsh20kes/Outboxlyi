import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import { LoginScreen } from './components/layout/LoginScreen.tsx';
import { WorkspaceShell } from './components/layout/WorkspaceShell.tsx';
import { ToastProvider } from './components/ui/Toast.tsx';

function AuthGate() {
  const { profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center gap-3 text-[#475569]">
        <Loader2 className="w-6 h-6 animate-spin text-[#1D4ED8]" />
        <p className="text-sm font-medium">Loading Outboxly workspace...</p>
      </div>
    );
  }

  if (!profile) {
    return <LoginScreen />;
  }

  return <WorkspaceShell />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ToastProvider>
  );
}
