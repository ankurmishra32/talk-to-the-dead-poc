// Client half of the Firebase AuthAdapter.
//
// Pre-refactor, this logic was duplicated across pages/index.tsx,
// pages/dashboard.tsx, components/PersonaSelection.tsx, and
// components/Chat.tsx. It now lives in one place and is wrapped
// behind the useAuth() hook.
//
// The auth instance is imported from firebase/config.ts so the
// Firebase app is initialized exactly once across the client bundle.

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { auth } from "../../firebase/config";
import type { AuthAdapter, AuthUser } from "./types";

function toAuthUser(u: User | null): AuthUser | null {
  if (!u) return null;
  return { uid: u.uid, email: u.email };
}

export const firebaseAuthClient: AuthAdapter = {
  getCurrentUser() {
    return toAuthUser(auth.currentUser);
  },
  onAuthChange(cb) {
    return onAuthStateChanged(auth, (u) => cb(toAuthUser(u)));
  },
  async getAccessToken() {
    return (await auth.currentUser?.getIdToken()) ?? null;
  },
  async signIn(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return toAuthUser(cred.user)!;
  },
  async signUp(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return toAuthUser(cred.user)!;
  },
  async signOut() {
    await firebaseSignOut(auth);
  },
  // Server-only method. Throws if called on the client.
  async verifyAccessToken() {
    throw new Error("verifyAccessToken is server-only.");
  },
};
