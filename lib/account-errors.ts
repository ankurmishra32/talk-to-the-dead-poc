// Maps a failure from deleteAccount() (lib/account.ts) to the message the
// user sees. Kept free of Firebase imports so it can be unit-tested.
//
// Firebase errors carry a `code`: Auth uses "auth/..." codes, Firestore uses
// bare gRPC-style codes such as "permission-denied" or "unavailable".

import { strings } from "./strings";

const WRONG_PASSWORD_CODES = new Set([
  // Current SDKs report a wrong password as invalid-credential (email
  // enumeration protection); older projects may still return the others.
  "auth/invalid-credential",
  "auth/invalid-login-credentials",
  "auth/wrong-password",
  "auth/user-mismatch",
  // deleteUser() after a stale login; re-entering the password fixes it.
  "auth/requires-recent-login",
]);

const NETWORK_CODES = new Set([
  "auth/network-request-failed",
  "unavailable",
  "deadline-exceeded",
]);

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Only a real credential problem says "Incorrect password". Anything else
 * may have happened after some data was already deleted, so it says so and
 * invites a retry (deleteAccount re-queries everything, so retrying is safe).
 */
export function accountDeletionErrorMessage(err: unknown): string {
  const code = errorCode(err);
  if (code && WRONG_PASSWORD_CODES.has(code)) return strings.account.authError;
  if (code === "auth/too-many-requests") return strings.account.tooManyAttempts;
  if (code && NETWORK_CODES.has(code)) return strings.account.networkError;
  return strings.account.partialFailure;
}
