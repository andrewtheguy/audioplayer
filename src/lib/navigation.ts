/**
 * Simple navigation helpers that dispatch events for route changes
 */

export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("routechange"));
}

export function navigateReplace(path: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new CustomEvent("routechange"));
}
