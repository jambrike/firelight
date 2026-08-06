import { Route, Router, Switch } from "wouter";
import { AppShell } from "../components/AppShell";
import { SessionBoundary } from "../features/identity/SessionBoundary";
import { AccountPage } from "../pages/AccountPage";
import { ActivatePage } from "../pages/ActivatePage";
import { AdminPage } from "../pages/AdminPage";
import { AuthPage } from "../pages/AuthPage";
import { CampPage } from "../pages/CampPage";
import { HomePage } from "../pages/HomePage";
import { KitPage } from "../pages/KitPage";
import { LearnPage } from "../pages/LearnPage";
import { LessonPage } from "../pages/LessonPage";
import { NotFoundPage } from "../pages/NotFoundPage";

export function AppRoutes() {
  return (
    <AppShell>
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
