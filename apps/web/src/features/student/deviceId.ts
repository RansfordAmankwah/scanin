const KEY = 'scanin_device_id';
let fallback: string | null = null;

/**
 * A random id that stays with this browser, so the server can notice one phone checking in several
 * students in the same class. It is not a hardware identifier and says nothing about the person.
 * If storage is blocked (private window), an id lasts for the life of the page instead.
 */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}
