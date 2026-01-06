/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { parseNpub } from "@/lib/nostr-crypto";
import { isValidSecondarySecret } from "@/lib/nostr-crypto";

const STORAGE_PREFIX = "com.audioplayer";
const NPUB_KEY = `${STORAGE_PREFIX}.npub`;
const SECRET_KEY = `${STORAGE_PREFIX}.secondary-secret`;
const HISTORY_KEY = `${STORAGE_PREFIX}.history.v1`;

interface AuthState {
  npub: string | null;
  pubkeyHex: string | null;
  secondarySecret: string | null;
  isLoggedIn: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (npub: string, secondarySecret: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Initial state is always loading - localStorage is read in useEffect to avoid SSR/hydration mismatch
const initialAuthState: AuthState = {
  npub: null,
  pubkeyHex: null,
  secondarySecret: null,
  isLoggedIn: false,
  isLoading: true,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialAuthState);

  // Restore auth state from localStorage after mount (client-side only)
  // This is a valid hydration pattern - reading external state on mount
  useEffect(() => {
    const storedNpub = localStorage.getItem(NPUB_KEY);
    const storedSecret = localStorage.getItem(SECRET_KEY);

    if (storedNpub && storedSecret) {
      const pubkeyHex = parseNpub(storedNpub);
      if (pubkeyHex && isValidSecondarySecret(storedSecret)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState({
          npub: storedNpub,
          pubkeyHex,
          secondarySecret: storedSecret,
          isLoggedIn: true,
          isLoading: false,
        });
        return;
      }

      // Stored credentials exist but are invalid - clear them
      localStorage.removeItem(NPUB_KEY);
      localStorage.removeItem(SECRET_KEY);
    }

    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  const login = useCallback(async (npub: string, secondarySecret: string): Promise<{ success: boolean; error?: string }> => {
    // Validate npub
    const pubkeyHex = parseNpub(npub);
    if (!pubkeyHex) {
      return { success: false, error: "Invalid npub format" };
    }

    // Validate secondary secret
    if (!isValidSecondarySecret(secondarySecret)) {
      return { success: false, error: "Invalid secondary secret format" };
    }

    // Store in localStorage
    localStorage.setItem(NPUB_KEY, npub);
    localStorage.setItem(SECRET_KEY, secondarySecret);

    // Update state
    setState({
      npub,
      pubkeyHex,
      secondarySecret,
      isLoggedIn: true,
      isLoading: false,
    });

    return { success: true };
  }, []);

  const logout = useCallback(() => {
    // Clear ALL localStorage data for this app
    localStorage.removeItem(NPUB_KEY);
    localStorage.removeItem(SECRET_KEY);
    localStorage.removeItem(HISTORY_KEY);

    // Reset state
    setState({
      npub: null,
      pubkeyHex: null,
      secondarySecret: null,
      isLoggedIn: false,
      isLoading: false,
    });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Export storage keys for readonly/cleanup only — do not mutate auth state directly.
// Use login() and logout() from useAuth() to modify authentication state.
export const AUTH_STORAGE_KEYS = {
  NPUB: NPUB_KEY,
  SECRET: SECRET_KEY,
  HISTORY: HISTORY_KEY,
} as const;
