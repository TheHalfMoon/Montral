/** What the email-verification bar remembers for this tab: whether it was dismissed, and whether the account was unverified. */
const DISMISSED = "montral_verify_dismissed";
const PENDING = "montral_verify_pending";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type VerifyBarStorage = {
  read(): { pending: boolean; dismissed: boolean };
  setPending(pending: boolean): void;
  dismiss(): void;
};

/** Session storage can be missing or refuse access (private modes, blocked site data): then nothing is remembered. */
export function verifyBarStorage(store: Store | null = safeSession()): VerifyBarStorage {
  const get = (k: string) => { try { return store?.getItem(k) === "1"; } catch { return false; } };
  return {
    read: () => ({ pending: get(PENDING), dismissed: get(DISMISSED) }),
    setPending: (pending) => { try { if (pending) store?.setItem(PENDING, "1"); else { store?.removeItem(PENDING); store?.removeItem(DISMISSED); } } catch {} },
    dismiss: () => { try { store?.setItem(DISMISSED, "1"); } catch {} },
  };
}

/** The bar's state before the account is fetched: shown at once when this tab already saw the account unverified. */
export function verifyBarAtFirstPaint(storage: VerifyBarStorage): { pending: boolean; dismissed: boolean } {
  return storage.read();
}

function safeSession(): Store | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
