import { describe, it, expect } from "vitest";
import { accountDeletionErrorMessage } from "../lib/account-errors";
import { strings } from "../lib/strings";

// Firebase errors are Error objects with a string `code`.
const fbError = (code: string) => Object.assign(new Error(`Firebase: Error (${code}).`), { code });

describe("accountDeletionErrorMessage", () => {
  it.each([
    "auth/invalid-credential",
    "auth/invalid-login-credentials",
    "auth/wrong-password",
    "auth/requires-recent-login",
  ])("says incorrect password for %s", (code) => {
    expect(accountDeletionErrorMessage(fbError(code))).toBe(strings.account.authError);
  });

  it("asks the user to wait after too many attempts", () => {
    expect(accountDeletionErrorMessage(fbError("auth/too-many-requests"))).toBe(
      strings.account.tooManyAttempts
    );
  });

  it.each(["auth/network-request-failed", "unavailable"])("reports %s as offline", (code) => {
    expect(accountDeletionErrorMessage(fbError(code))).toBe(strings.account.networkError);
  });

  it("does not blame the password for a Firestore failure partway through", () => {
    expect(accountDeletionErrorMessage(fbError("permission-denied"))).toBe(
      strings.account.partialFailure
    );
  });

  it("falls back to the partial-failure message for unknown errors", () => {
    expect(accountDeletionErrorMessage(new Error("boom"))).toBe(strings.account.partialFailure);
    expect(accountDeletionErrorMessage(undefined)).toBe(strings.account.partialFailure);
  });
});
