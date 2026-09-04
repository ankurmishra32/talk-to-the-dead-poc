// Shared auth contract. The PoC ships with one implementation
// (lib/auth/firebase.ts). A future provider swap is a new file in
// lib/auth/ + an env var change.
//
// The interface is intentionally the same on client and server: client
// code uses the user-facing methods (signIn, signOut, getAccessToken,
// onAuthChange), server code uses verifyAccessToken. The factory
// returns the same shape on both sides; the runtime environment is
// implicit because client and server bundles never import the same
// adapter instance.

export type AuthUser = {
  uid: string;
  email?: string | null;
};

export type AuthAdapter = {
  // Client-side.
  getCurrentUser(): AuthUser | null;
  onAuthChange(cb: (u: AuthUser | null) => void): () => void;
  getAccessToken(): Promise<string | null>;
  signIn(email: string, password: string): Promise<AuthUser>;
  signUp(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  // Server-side. Throws if the token is missing/malformed/rejected.
  verifyAccessToken(token: string): Promise<AuthUser>;
};
