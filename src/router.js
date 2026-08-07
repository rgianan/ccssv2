const ROUTES = {
  "/": "landing",
  "/survey": "survey",
  "/verification": "verification",
  "/admin": "admin",
};

export function getRoute() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return ROUTES[path] || "landing";
}

export function navigate(path) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

export function subscribeToRouteChange(listener) {
  const onPopState = () => listener(getRoute());
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}
