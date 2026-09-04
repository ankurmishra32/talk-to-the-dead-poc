// Server half of the Firebase AuthAdapter.
//
// Pre-refactor, getUidFromAuthHeader lived in lib/firestore.ts. It
// used the Identity Toolkit's accounts:lookup REST endpoint with the
// browser API key. The same logic, refactored to return an AuthUser
// instead of a raw uid, lives here.
//
// The API key identifies the Firebase project, not the calling user.

import type { AuthAdapter, AuthUser } from "./types";

const IDENTITY_TOOLKIT_BASE = "https://identitytoolkit.googleapis.com/v1";

function getApiKey(): string {
  const key = process.env.FIREBASE_API_KEY;
  if (!key) {
    throw new Error(
      "FIREBASE_API_KEY not configured. Add it to .env.local. " +
        "This is the same value used in firebase/config.ts."
    );
  }
  return key;
}

async function verifyAccessToken(token: string): Promise<AuthUser> {
  // Tolerate both "Bearer x" and bare "x" so the route can pass the
  // raw Authorization header without preprocessing.
  const idToken = token.startsWith("Bearer ")
    ? token.slice("Bearer ".length).trim()
    : token.trim();
  if (!idToken) {
    throw new Error("Empty bearer token.");
  }

  const url = `${IDENTITY_TOOLKIT_BASE}/accounts:lookup?key=${getApiKey()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });

  if (!res.ok) {
    // 400 with INVALID_ID_TOKEN is the common case. We don't surface
    // the exact reason to the client — just throw so the route
    // returns 401.
    throw new Error("ID token rejected by Identity Toolkit.");
  }

  type LookupResponse = {
    users?: Array<{
      localId?: string;
      email?: string;
      valid?: string | boolean;
    }>;
  };
  const data = (await res.json()) as LookupResponse;
  const user = data.users?.[0];
  const uid = user?.localId;
  if (!uid || user.valid === false || user.valid === "false") {
    throw new Error("Identity Toolkit did not return a valid user.");
  }
  return { uid, email: user.email ?? null };
}

export const firebaseAuthServer: AuthAdapter = {
  // Client-only methods. Throwing is safer than silently returning
  // null here — accidentally calling a client method on the server is
  // a bug we want to surface.
  getCurrentUser() {
    throw new Error("getCurrentUser is client-only.");
  },
  onAuthChange() {
    throw new Error("onAuthChange is client-only.");
  },
  async getAccessToken() {
    throw new Error("getAccessToken is client-only.");
  },
  async signIn() {
    throw new Error("signIn is client-only.");
  },
  async signUp() {
    throw new Error("signUp is client-only.");
  },
  async signOut() {
    throw new Error("signOut is client-only.");
  },
  verifyAccessToken,
};
