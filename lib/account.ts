import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  deleteUser,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase/config";

const BATCH_SIZE = 450;

async function deleteQueryBatch(q: ReturnType<typeof query>): Promise<number> {
  const snap = await getDocs(q);
  if (snap.empty) return 0;

  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = snap.docs.slice(i, i + BATCH_SIZE);
    for (const d of chunk) {
      batch.delete(d.ref);
      deleted++;
    }
    await batch.commit();
  }
  return deleted;
}

/**
 * Delete a persona together with everything that hangs off it: its
 * memories and its conversation messages. Children go first and the
 * persona doc last, so a failure part-way leaves the persona visible and
 * the user can simply retry the delete (instead of orphaning data that
 * no UI can reach any more).
 */
export async function deletePersonaWithData(uid: string, personaId: string): Promise<void> {
  await deleteQueryBatch(
    query(
      collection(db, "memories"),
      where("userId", "==", uid),
      where("personaId", "==", personaId)
    )
  );
  await deleteQueryBatch(
    query(
      collection(db, "conversations", personaId, "messages"),
      where("userId", "==", uid)
    )
  );
  await deleteDoc(doc(db, "personas", personaId));
}

/**
 * Delete everything associated with a Firebase user:
 *  1. Re-authenticate (Firebase requires recent credentials).
 *  2. Delete Firestore documents (personas, memories, conversation messages, user profile).
 *  3. Delete the Firebase Auth account.
 */
export async function deleteAccount(user: User, password: string): Promise<void> {
  if (!user.email) {
    throw new Error("User has no email — cannot re-authenticate.");
  }

  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);

  const uid = user.uid;

  // --- Firestore cleanup ---

  // 1. Personas
  const personasSnap = await getDocs(
    query(collection(db, "personas"), where("userId", "==", uid))
  );

  // 2. Memories
  await deleteQueryBatch(
    query(collection(db, "memories"), where("userId", "==", uid))
  );

  // 3. Conversation messages (subcollection under each persona)
  for (const personaDoc of personasSnap.docs) {
    await deleteQueryBatch(
      query(
        collection(db, "conversations", personaDoc.id, "messages"),
        where("userId", "==", uid)
      )
    );
  }

  // 4. Persona docs themselves
  if (!personasSnap.empty) {
    let i = 0;
    while (i < personasSnap.docs.length) {
      const batch = writeBatch(db);
      const chunk = personasSnap.docs.slice(i, i + BATCH_SIZE);
      for (const d of chunk) {
        batch.delete(d.ref);
      }
      await batch.commit();
      i += chunk.length;
    }
  }

  // 5. User profile. Deleting a doc that doesn't exist already succeeds, so
  // any error here is real (permission-denied, offline) and must stop us
  // before the auth account goes — otherwise the profile (name, phone,
  // email) would be left behind with nobody able to delete it.
  await deleteDoc(doc(db, "users", uid));

  // --- Auth account ---
  await deleteUser(user);
}
