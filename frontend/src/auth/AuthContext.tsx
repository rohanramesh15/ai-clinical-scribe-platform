import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/api/client";
import type { Provider } from "@/api/types";

type Status = "loading" | "authed" | "anon";

interface AuthState {
  status: Status;
  provider: Provider | null;
  deactivated: boolean; // set when a 403 account_deactivated is seen
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Components call this in catch blocks to react to 401/403 centrally. */
  handleAuthError: (err: unknown) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [deactivated, setDeactivated] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setProvider(r.provider);
        setStatus("authed");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setDeactivated(true);
        setStatus("anon");
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setDeactivated(false);
    setProvider(r.provider);
    setStatus("authed");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setProvider(null);
      setStatus("anon");
    }
  }, []);

  const handleAuthError = useCallback((err: unknown) => {
    if (!(err instanceof ApiError)) return;
    if (err.status === 403 && err.detail === "account_deactivated") {
      setDeactivated(true);
      setProvider(null);
      setStatus("anon");
    } else if (err.status === 401) {
      setProvider(null);
      setStatus("anon");
    }
  }, []);

  const value = useMemo(
    () => ({ status, provider, deactivated, login, logout, handleAuthError }),
    [status, provider, deactivated, login, logout, handleAuthError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
