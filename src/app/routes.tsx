import { Route, Router, Switch } from "wouter";
import { AppShell } from "../components/AppShell";
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
        <Route path="/activate" component={ActivatePage} />
        <Route path="/camp" component={CampPage} />
        <Route path="/learn" component={LearnPage} />
        <Route path="/learn/:lesson" component={LessonPage} />
        <Route path="/account" component={AccountPage} />
        <Route path="/admin" component={AdminPage} />
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
