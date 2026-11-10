"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "companyos-admin-token";

type AdminTokenStore = { token: string; setToken: (value: string) => void };

const AdminTokenContext = createContext<AdminTokenStore>({ token: "", setToken: () => undefined });

/**
 * One shared admin token for the whole app, kept in sessionStorage so it
 * survives navigation within the tab but is gone when the tab closes.
 * Enter it once on any screen and every admin-gated panel can use it.
 */
export function AdminTokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState("");

  useEffect(() => {
    try {
      setTokenState(window.sessionStorage.getItem(STORAGE_KEY) ?? "");
    } catch {
      // Storage can be unavailable (privacy mode); the token then lives in memory only.
    }
  }, []);

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    try {
      if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
      else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // See above: in-memory only.
    }
  }, []);

  return <AdminTokenContext.Provider value={{ token, setToken }}>{children}</AdminTokenContext.Provider>;
}

export function useAdminToken(): AdminTokenStore {
  return useContext(AdminTokenContext);
}

/** The one admin-token input every panel renders; bound to the shared store. */
export function AdminTokenField({ className = "" }: { className?: string }) {
  const { token, setToken } = useAdminToken();
  return (
    <label className={`router-field${className ? ` ${className}` : ""}`}>
      Admin token
      <input
        type="password"
        autoComplete="current-password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="Required by COMPANYOS_ADMIN_TOKEN"
      />
    </label>
  );
}
