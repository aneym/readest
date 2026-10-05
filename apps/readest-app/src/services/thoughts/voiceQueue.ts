import type { ThoughtAttachment } from './client';

const MAX_TAKE_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 4 * MAX_TAKE_BYTES;
export interface PendingVoice {
  audio: Blob;
  id: string;
  recordedAt: string;
  attachment?: ThoughtAttachment;
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('homebase-thoughts-voice-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('takes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** One transaction bounds the durable queue even when two windows capture together. */
export async function queueVoice(take: PendingVoice): Promise<boolean> {
  if (take.audio.size > MAX_TAKE_BYTES) return false;
  try {
    const db = await database();
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction('takes', 'readwrite');
      const store = tx.objectStore('takes');
      const request = store.getAll();
      let saved = false;
      request.onsuccess = () => {
        const takes: PendingVoice[] = request.result;
        const size = takes
          .filter((item) => item.id !== take.id)
          .reduce((total, item) => total + item.audio.size, take.audio.size);
        if (size <= MAX_QUEUE_BYTES) {
          store.put(take);
          saved = true;
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve(saved);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        resolve(false);
      };
    });
  } catch {
    return false;
  }
}

export async function readVoiceQueue(): Promise<PendingVoice[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('takes', 'readonly');
    const request = tx.objectStore('takes').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = tx.onabort = () => db.close();
  });
}

export async function removeVoice(id: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('takes', 'readwrite');
    tx.objectStore('takes').delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
