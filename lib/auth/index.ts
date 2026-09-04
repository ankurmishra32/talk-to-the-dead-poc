// Type re-exports. Importing this from either the client or server
// is safe — there is no runtime code and no Firebase SDK import.
//
// For the runtime adapter, use one of:
//   - lib/auth/client.ts  (in React components / pages)
//   - lib/auth/server.ts  (in pages/api/* routes)
//
// This split exists because the Firebase JS SDK cannot be loaded
// into the Node server bundle. The two entry points are mirrored so
// either side gets an AuthAdapter with the same shape.
//
// The AuthAdapter type itself is imported directly from lib/auth/types
// by the client/server entry points; this barrel only re-exports the
// AuthUser the pages need.

export type { AuthUser } from "./types";
