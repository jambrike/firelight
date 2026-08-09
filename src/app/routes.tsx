import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Route, Router, Switch, useLocation } from "wouter";
import { AppShell } from "../components/AppShell";
import { Panel } from "../components/ui";
import { SessionBoundary } from "../features/identity/SessionBoundary";
import { HomePage } from "../pages/HomePage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { getRouteMetadata } from "./route-metadata";

const KitPage = lazy(async () => {
  const module = await import("../pages/KitPage");
  return { default: module.KitPage };
});

const AuthPage = lazy(async () => {
  const module = await import("../pages/AuthPage");
  return { default: module.AuthPage };
});

const ActivatePage = lazy(async () => {
  const module = await import("../pages/ActivatePage");
  return { default: module.ActivatePage };
});

const CampPage = lazy(async () => {
  const module = await import("../pages/CampPage");
  return { default: module.CampPage };
});

const LearnPage = lazy(async () => {
  const module = await import("../pages/LearnPage");
  return { default: module.LearnPage };
});

const LessonPage = lazy(async () => {
  const module = await import("../pages/LessonPage");
  return { default: module.LessonPage };
});

const AccountPage = lazy(async () => {
  const module = await import("../pages/AccountPage");
  return { default: module.AccountPage };
});

const AdminPage = lazy(async () => {
  const module = await import("../pages/AdminPage");
  return { default: module.AdminPage };
});

function RoutePending() {
  return (
    <div className="page-section narrow-page page-stack route-pending">
      <div role="status" aria-live="polite" aria-atomic="true">
        <Panel>
          <p className="eyebrow">Following the trail</p>
          <p>Loading this part of camp…</p>
        </Panel>
      </div>
    </div>
  );
}

function RouteSwitch() {
  const [location] = useLocation();
  const previousLocationRef = useRef(location);
  const [announcement, setAnnouncement] = useState({ location, message: "" });

  useEffect(() => {
    if (previousLocationRef.current !== location) {
      setAnnouncement({
        location,
        message: `${getRouteMetadata(location).announcement} loaded.`,
      });
    }
    previousLocationRef.current = location;
  }, [location]);

  const currentAnnouncement = announcement.location === location ? announcement.message : "";

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {currentAnnouncement}
      </p>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/kit" component={KitPage} />
        <Route path="/auth" component={AuthPage} />
        <Route path="/activate">
          <SessionBoundary>
            <ActivatePage />
          </SessionBoundary>
        </Route>
        <Route path="/camp">
          <SessionBoundary>
            <CampPage />
          </SessionBoundary>
        </Route>
        <Route path="/learn" component={LearnPage} />
        <Route path="/learn/:lesson" component={LessonPage} />
        <Route path="/account">
          <SessionBoundary>
            <AccountPage />
          </SessionBoundary>
        </Route>
        <Route path="/admin">
          <SessionBoundary admin>
            <AdminPage />
          </SessionBoundary>
        </Route>
        <Route component={NotFoundPage} />
      </Switch>
    </>
  );
}

export function AppRoutes() {
  const [location] = useLocation();

  return (
    <AppShell>
      <RouteErrorBoundary resetKey={location}>
        <Suspense fallback={<RoutePending />}>
          <RouteSwitch />
        </Suspense>
      </RouteErrorBoundary>
    </AppShell>
  );
}

export function AppRouter() {
  return (
    <Router>
      <AppRoutes />
    </Router>
  );
}
