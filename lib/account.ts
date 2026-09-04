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

  // 5. User profile
  await deleteDoc(doc(db, "users", uid)).catch(() => {
    // May not exist for legacy users — ignore.
  });

  // --- Auth account ---
  await deleteUser(user);
}
