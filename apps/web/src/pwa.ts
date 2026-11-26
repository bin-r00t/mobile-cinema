/*
 * The PWA wiring: the service worker and the install prompt.
 *
 * The service worker is registered here once, when the app starts. The
 * install prompt is an event the browser hands out exactly once
 * (beforeinstallprompt), so it is kept in a tiny store that the button in
 * the header subscribes to.
 */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Subscribes to changes of the install availability; returns the unsubscribe. */
export function onInstallAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/** Shows the install prompt of the browser; null when there is none. */
export async function install(): Promise<"accepted" | "dismissed" | null> {
  const prompt = deferredPrompt;
  if (!prompt) return null;
  deferredPrompt = null;
  notify();
  await prompt.prompt();
  return (await prompt.userChoice).outcome;
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // Registered after the page has loaded, so it never competes with the
  // first render.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Without a service worker the app still works, it is only not
      // installable and not offline-capable.
    });
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}
