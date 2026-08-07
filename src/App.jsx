import React, { Suspense, lazy, useEffect, useState } from "react";
import { LandingPage } from "./views/LandingPage";
import { SurveyForm } from "./views/SurveyForm";
import { VerificationPage } from "./views/VerificationPage";
import { getRoute, subscribeToRouteChange } from "./router";

// The admin module is the largest bundle and is never opened by clients, so it
// stays a separate chunk behind the /admin route.
const AdminDashboard = lazy(() =>
  import("./views/AdminViews").then((m) => ({ default: m.AdminDashboard })),
);

export function App() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => subscribeToRouteChange(setRoute), []);
  if (route === "admin")
    return (
      <Suspense fallback={<div className="route-fallback">Loading…</div>}>
        <AdminDashboard />
      </Suspense>
    );
  if (route === "survey") return <SurveyForm />;
  if (route === "verification") return <VerificationPage />;
  return <LandingPage />;
}
