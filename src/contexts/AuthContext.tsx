import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  auth,
  gmailAuthProvider,
  googleAuthProvider,
} from '../lib/firebase.ts';
import {
  clearServerGmailToken,
  fetchGmailStatus,
  fetchUserProfile,
  loginWithPassword,
  registerGmailSender,
  resendVerificationEmail as apiResendVerificationEmail,
  signupWithPassword,
  verifySignupEmail as apiVerifySignupEmail,
} from '../lib/api.ts';
import type { PendingSignupResult, UserProfile } from '../types/scheduler.ts';

interface GmailMemoryToken {
  token: string;
  email: string | null;
  expiresAt: number;
}

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  loading: boolean;
  authError: string | null;
  gmailConnected: boolean;
  gmailEmail: string | null;
  clearAuthError: () => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (
    name: string,
    email: string,
    password: string
  ) => Promise<PendingSignupResult>;
  verifySignupEmail: (payload: {
    email?: string;
    code?: string;
    token?: string;
  }) => Promise<void>;
  resendVerificationEmail: (email: string) => Promise<PendingSignupResult>;
  connectGmail: () => Promise<{ email: string; accessToken: string }>;
  getGmailAccessToken: () => string | null;
  refreshGmailStatus: () => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const GMAIL_TTL_MS = 50 * 60 * 1000;

function formatGoogleAuthError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (code === 'auth/popup-closed-by-user') {
      return 'Google sign-in popup was closed. If Google showed "Access blocked / testing", use email Sign In / Create Account or add this email as a Test User in Google Cloud Console.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many attempts. Please wait a moment and try again.';
    }
  }
  return err instanceof Error ? err.message : fallback;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);

  // In-memory bearer & OAuth access tokens (never persisted to localStorage/sessionStorage)
  const memoryTokenRef = useRef<string | null>(null);
  const gmailTokenRef = useRef<GmailMemoryToken | null>(null);
  const connectingGmailOnlyRef = useRef(false);

  const loadProfileWithToken = useCallback(async (token: string) => {
    const userProfile = await fetchUserProfile(token);
    setProfile(userProfile);
  }, []);

  const syncServerGmailStatus = useCallback(async (token: string) => {
    try {
      const status = await fetchGmailStatus(token);
      setGmailConnected(status.connected);
      setGmailEmail(status.gmailEmail);
      return status.connected;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (connectingGmailOnlyRef.current) {
        return;
      }

      setFirebaseUser(user);
      if (!user) {
        if (!memoryTokenRef.current) {
          gmailTokenRef.current = null;
          setGmailConnected(false);
          setGmailEmail(null);
          setProfile(null);
        }
        setLoading(false);
        return;
      }

      // Preserve active email/password session if Gmail OAuth popup triggered Firebase auth state
      if (memoryTokenRef.current) {
        setLoading(false);
        return;
      }

      try {
        const token = await user.getIdToken();
        await loadProfileWithToken(token);
        setAuthError(null);

        if (
          gmailTokenRef.current &&
          Date.now() < gmailTokenRef.current.expiresAt
        ) {
          try {
            const reg = await registerGmailSender(
              token,
              gmailTokenRef.current.token
            );
            setGmailConnected(reg.gmailConnected);
            setGmailEmail(reg.gmailEmail);
          } catch (regErr) {
            console.warn('Auto-registering Gmail sender skipped:', regErr);
          }
        } else {
          await syncServerGmailStatus(token);
        }
      } catch (err) {
        console.error('Failed to sync authenticated profile:', err);
        setAuthError(
          err instanceof Error ? err.message : 'Unable to verify session with server.'
        );
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [loadProfileWithToken, syncServerGmailStatus]);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const getIdToken = useCallback(async () => {
    if (memoryTokenRef.current) {
      return memoryTokenRef.current;
    }
    if (auth.currentUser) {
      return auth.currentUser.getIdToken();
    }
    throw new Error('User is not authenticated');
  }, []);

  const refreshGmailStatus = useCallback(async () => {
    try {
      const token = await getIdToken();
      return await syncServerGmailStatus(token);
    } catch {
      setGmailConnected(false);
      setGmailEmail(null);
      return false;
    }
  }, [getIdToken, syncServerGmailStatus]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      memoryTokenRef.current = null;
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      setAuthError(
        formatGoogleAuthError(err, 'Google authentication failed. Please try again.')
      );
      throw err;
    }
  }, []);

  const connectGmail = useCallback(async () => {
    const workspaceToken = await getIdToken();
    const hadLocalSession = Boolean(memoryTokenRef.current);
    connectingGmailOnlyRef.current = hadLocalSession;

    try {
      const result = await signInWithPopup(auth, gmailAuthProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const accessToken = credential?.accessToken;
      if (!accessToken) {
        throw new Error(
          'Google did not grant Gmail send access. Please allow the Gmail permission when prompted.'
        );
      }

      const registered = await registerGmailSender(workspaceToken, accessToken);
      gmailTokenRef.current = {
        token: accessToken,
        email: registered.gmailEmail,
        expiresAt: Date.now() + GMAIL_TTL_MS,
      };
      setGmailConnected(true);
      setGmailEmail(registered.gmailEmail);

      return { email: registered.gmailEmail, accessToken };
    } catch (err) {
      throw new Error(
        formatGoogleAuthError(err, 'Unable to connect Gmail account.')
      );
    } finally {
      connectingGmailOnlyRef.current = false;
    }
  }, [getIdToken]);

  const getGmailAccessToken = useCallback(() => {
    const entry = gmailTokenRef.current;
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      gmailTokenRef.current = null;
      return null;
    }
    return entry.token;
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      setAuthError(null);
      try {
        const res = await loginWithPassword({ email: email.trim(), password });
        memoryTokenRef.current = res.token;
        gmailTokenRef.current = null;
        setProfile(res.user);
        await syncServerGmailStatus(res.token);
        setLoading(false);
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Sign in failed. Please check your credentials.'
        );
        throw err;
      }
    },
    [syncServerGmailStatus]
  );

  const signUpWithEmail = useCallback(
    async (name: string, email: string, password: string) => {
      setAuthError(null);
      try {
        return await signupWithPassword({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Account creation failed. Please try again.'
        );
        throw err;
      }
    },
    []
  );

  const verifySignupEmail = useCallback(
    async (payload: { email?: string; code?: string; token?: string }) => {
      setAuthError(null);
      try {
        const res = await apiVerifySignupEmail(payload);
        memoryTokenRef.current = res.token;
        gmailTokenRef.current = null;
        setGmailConnected(false);
        setGmailEmail(null);
        setProfile(res.user);
        setLoading(false);
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Email verification failed. Please try again.'
        );
        throw err;
      }
    },
    []
  );

  const resendVerificationEmail = useCallback(async (email: string) => {
    setAuthError(null);
    try {
      return await apiResendVerificationEmail(email.trim());
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Could not resend verification email.'
      );
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      const token = await getIdToken();
      await clearServerGmailToken(token);
    } catch {
      // ignore if already unauthenticated
    }

    memoryTokenRef.current = null;
    gmailTokenRef.current = null;
    setGmailConnected(false);
    setGmailEmail(null);
    if (auth.currentUser) {
      await signOut(auth);
    }
    setProfile(null);
  }, [getIdToken]);

  const refreshProfile = useCallback(async () => {
    const token = await getIdToken();
    await loadProfileWithToken(token);
  }, [getIdToken, loadProfileWithToken]);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile,
        loading,
        authError,
        gmailConnected,
        gmailEmail,
        clearAuthError,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        verifySignupEmail,
        resendVerificationEmail,
        connectGmail,
        getGmailAccessToken,
        refreshGmailStatus,
        logout,
        refreshProfile,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
