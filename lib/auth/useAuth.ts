// React hook that wraps the auth adapter's onAuthChange.
//
// Replaces the direct firebase/auth usage that used to be in
// pages/dashboard.tsx and components/PersonaSelection.tsx.
// The hook re-renders the consumer whenever the auth state changes,
// and exposes the same signIn / signUp / signOut / getAccessToken
// methods the adapter provides.

import { useEffect, useState } from "react";
import { authAdapter } from "./client";
import type { AuthUser } from "./types";

export type UseAuth = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signUp: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
};

export function useAuth(): UseAuth {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = authAdapter.onAuthChange((u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return {
    user,
    loading,
    signIn: authAdapter.signIn.bind(authAdapter),
    signUp: authAdapter.signUp.bind(authAdapter),
    signOut: authAdapter.signOut.bind(authAdapter),
    getAccessToken: authAdapter.getAccessToken.bind(authAdapter),
  };
}
