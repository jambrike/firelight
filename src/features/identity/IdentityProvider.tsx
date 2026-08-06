import { createClient } from "@supabase/supabase-js";
import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LessonSlug } from "../../../shared/curriculum";
import type {
  BootstrapData,
  ProgressUpdateInput,
} from "../../../shared/identity";
import { FirelightApi } from "./api";
import { IdentityContext } from "./identity-context";
import type { IdentityStatus } from "./identity-context";
import { legacyKeys, migrateLegacyData } from "./legacy";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

export function IdentityProvider({ children }: { readonly children: ReactNode }) {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<IdentityStatus>("loading");
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const bootstrapGenerationRef = useRef(0);

  useEffect(() => {
    let active = true;
    const loadConfig = async () => {
      try {
        const config = await new FirelightApi().getConfig();
        if (!active) return;
        const client = createClient(
          config.supabase.url,
          config.supabase.publishableKey,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              flowType: "pkce",
            },
          },
        );
        setSupabase(client);
      } catch (configError) {
        if (!active) return;
        setStatus("error");
        setError(messageFrom(configError));
      }
    };
    void loadConfig();
    return () => {
      active = false;
    };
  }, []);

  const loadBootstrap = useCallback(async (activeSession: Session) => {
    const generation = ++bootstrapGenerationRef.current;
    const isCurrentSession = () =>
      bootstrapGenerationRef.current === generation &&
      sessionRef.current?.access_token === activeSession.access_token;
    const api = new FirelightApi(() => activeSession.access_token);
    const bootstrap = await api.getBootstrap();
    if (!isCurrentSession()) return;
    window.localStorage.removeItem(legacyKeys.plaintextPassword);

    let migrated = false;
    if (bootstrap.activation) {
      try {
        migrated = await migrateLegacyData(window.localStorage, bootstrap, {
          async updateProfile(displayName) {
            if (!isCurrentSession()) throw new Error("Session changed during legacy migration.");
            const result = await api.updateProfile(displayName);
            if (!isCurrentSession()) throw new Error("Session changed during legacy migration.");
            return result;
          },
          async saveProgress(lessonId, input) {
            if (!isCurrentSession()) throw new Error("Session changed during legacy migration.");
            const result = await api.saveProgress(lessonId, input);
            if (!isCurrentSession()) throw new Error("Session changed during legacy migration.");
            return result;
          },
        });
      } catch (migrationError) {
        if (!isCurrentSession()) return;
        setNotice(
          migrationError instanceof Error
            ? migrationError.message
            : "Your account loaded, but legacy progress will retry on the next visit.",
        );
      }
    }

    const current = migrated ? await api.getBootstrap() : bootstrap;
    if (!isCurrentSession()) return;
    setData(current);
    setStatus("authenticated");
    setError(null);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let lastAppliedToken: string | null | undefined;

    const applySession = async (nextSession: Session | null) => {
      const nextToken = nextSession?.access_token ?? null;
      if (lastAppliedToken === nextToken) return;
      lastAppliedToken = nextToken;
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (!nextSession) {
        bootstrapGenerationRef.current += 1;
        setData(null);
        setStatus("anonymous");
        setError(null);
        return;
      }
      setStatus("loading");
      const bootstrapGeneration = bootstrapGenerationRef.current + 1;
      try {
        await loadBootstrap(nextSession);
      } catch (bootstrapError) {
        if (
          !active ||
          bootstrapGenerationRef.current !== bootstrapGeneration ||
          sessionRef.current?.access_token !== nextSession.access_token
        ) {
          return;
        }
        setStatus("error");
        setError(messageFrom(bootstrapError));
      }
    };

    const handleAuthChange = (event: AuthChangeEvent, nextSession: Session | null) => {
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      void applySession(nextSession);
    };

    const subscription = supabase.auth.onAuthStateChange(handleAuthChange).data.subscription;
    void supabase.auth.getSession().then(({ data: result, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setStatus("error");
        setError(sessionError.message);
        return;
      }
      void applySession(result.session);
    });

    return () => {
      active = false;
      bootstrapGenerationRef.current += 1;
      subscription.unsubscribe();
    };
  }, [loadBootstrap, supabase]);

  const requireClient = useCallback((): SupabaseClient => {
    if (!supabase) throw new Error("Account services are still loading.");
    return supabase;
  }, [supabase]);

  const api = useCallback(() => {
    const activeSession = sessionRef.current;
    return new FirelightApi(() => activeSession?.access_token ?? null);
  }, []);

  const refresh = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error("Sign in to continue.");
    await loadBootstrap(activeSession);
  }, [loadBootstrap]);

  const value = useMemo(
    () => ({
      status,
      session,
      data,
      error,
      notice,
      recoveryMode,
      supabase,
      async signUp(email: string, password: string, displayName: string) {
        setNotice(null);
        const { data: result, error: signUpError } = await requireClient().auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName.trim() },
            emailRedirectTo: `${window.location.origin}/auth`,
          },
        });
        if (signUpError) throw signUpError;
        if (!result.session) {
          setNotice("Check your email to confirm the account, then sign in.");
        }
      },
      async signIn(email: string, password: string) {
        setNotice(null);
        const { error: signInError } = await requireClient().auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
      },
      async signOut() {
        const { error: signOutError } = await requireClient().auth.signOut();
        if (signOutError) throw signOutError;
        setNotice("You are signed out.");
      },
      async requestPasswordReset(email: string) {
        const { error: resetError } = await requireClient().auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth?mode=reset`,
        });
        if (resetError) throw resetError;
        setNotice("Check your email for a password reset link.");
      },
      async updatePassword(password: string) {
        const { error: passwordError } = await requireClient().auth.updateUser({ password });
        if (passwordError) throw passwordError;
        setRecoveryMode(false);
        setNotice("Your password has been updated.");
      },
      refresh,
      async updateProfile(displayName: string) {
        const profile = await api().updateProfile(displayName);
        setData((current) => (current ? { ...current, profile } : current));
        return profile;
      },
      async claimKit(code: string) {
        const activation = await api().claimKit(code);
        await refresh();
        return activation;
      },
      async saveProgress(lessonId: LessonSlug, input: ProgressUpdateInput) {
        const progress = await api().saveProgress(lessonId, input);
        setData((current) => {
          if (!current) return current;
          const remaining = current.progress.filter(
            (item) =>
              item.lessonId !== progress.lessonId ||
              item.lessonVersion !== progress.lessonVersion,
          );
          return { ...current, progress: [...remaining, progress] };
        });
        return progress;
      },
      async deleteAccount() {
        await api().deleteAccount();
        await requireClient().auth.signOut({ scope: "local" });
        sessionRef.current = null;
        bootstrapGenerationRef.current += 1;
        setSession(null);
        setData(null);
        setStatus("anonymous");
      },
    }),
    [
      api,
      data,
      error,
      notice,
      recoveryMode,
      refresh,
      requireClient,
      session,
      status,
      supabase,
    ],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
