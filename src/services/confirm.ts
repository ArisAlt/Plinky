// In-app confirmation. window.confirm showed nothing at all under
// WebKitGTK in the critique's run: a vault credential was deleted on one
// click with no dialog on screen. One host, mounted once in App, draws these.

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  /** Red confirm button, for what cannot be undone. */
  danger?: boolean;
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };
type Listener = (req: Pending | null) => void;

let listener: Listener | null = null;

/** Called by ConfirmHost; returns its unsubscribe. */
export function setConfirmListener(l: Listener): () => void {
  listener = l;
  return () => { if (listener === l) listener = null; };
}

/** Resolves true only when the user presses the confirm button. */
export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  // No host (a component rendered on its own, as in a unit test): the
  // browser's dialog is the only one there is.
  if (!listener) return Promise.resolve(window.confirm(req.body ? `${req.title}\n\n${req.body}` : req.title));
  return new Promise(resolve => listener!({ ...req, resolve }));
}
