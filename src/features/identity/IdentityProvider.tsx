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
import {
  mergeProgressCache,
  mergeProgressCollections,
} from "./progress-cache";
import { purgeBrowserProgressDraftsForOwner } from "../progress/draft-persistence";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

interface IdentityMutationScope {
  readonly accessToken: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
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
  const dataRef = useRef<BootstrapData | null>(null);
  const ownerGenerationRef = useRef(0);
  const bootstrapGenerationRef = useRef(0);

  const commitData = useCallback(
    (
      update:
        | BootstrapData
        | null
        | ((current: BootstrapData | null) => BootstrapData | null),
    ): BootstrapData | null => {
      const next = typeof update === "function" ? update(dataRef.current) : update;
      dataRef.current = next;
      setData(next);
      return next;
    },
    [],
  );

  const captureMutationScope = useCallback((): IdentityMutationScope => {
    const activeSession = sessionRef.current;
    const current = dataRef.current;
    if (!activeSession || activeSession.user.id !== current?.profile.id) {
      throw new Error("Your account changed before Firelight could start this request.");
    }
    return {
      accessToken: activeSession.access_token,
      ownerId: current.profile.id,
      ownerGeneration: ownerGenerationRef.current,
    };
  }, []);

  const mutationScopeIsCurrent = useCallback(
    (scope: IdentityMutationScope): boolean =>
      sessionRef.current?.user.id === scope.ownerId &&
      dataRef.current?.profile.id === scope.ownerId &&
      ownerGenerationRef.current === scope.ownerGeneration,
    [],
  );

  const assertCurrentMutationScope = useCallback(
    (scope: IdentityMutationScope): void => {
      if (!mutationScopeIsCurrent(scope)) {
        throw new Error("Your account changed before Firelight finished this request.");
      }
    },
    [mutationScopeIsCurrent],
  );

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

  const loadBootstrap = useCallback(async (activeSession: Session): Promise<BootstrapData | null> => {
    const generation = ++bootstrapGenerationRef.current;
    const isCurrentSession = () =>
      bootstrapGenerationRef.current === generation &&
      sessionRef.current?.access_token === activeSession.access_token;
    const api = new FirelightApi(() => activeSession.access_token);
    const bootstrap = await api.getBootstrap();
    if (!isCurrentSession()) return null;
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
        if (!isCurrentSession()) return null;
        setNotice(
          migrationError instanceof Error
            ? migrationError.message
            : "Your account loaded, but legacy progress will retry on the next visit.",
        );
      }
    }

    const current = migrated ? await api.getBootstrap() : bootstrap;
    if (!isCurrentSession()) return null;
    const merged = commitData((cached) =>
      cached?.profile.id === current.profile.id
        ? {
            ...current,
            progress: mergeProgressCollections(cached.progress, current.progress),
          }
        : current,
    );
    setStatus("authenticated");
    setError(null);
    return merged;
  }, [commitData]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let lastAppliedToken: string | null | undefined;

    const applySession = async (nextSession: Session | null) => {
      const nextToken = nextSession?.access_token ?? null;
      if (lastAppliedToken === nextToken) return;
      lastAppliedToken = nextToken;
      const previousOwnerId = sessionRef.current?.user.id ?? null;
      const nextOwnerId = nextSession?.user.id ?? null;
      const ownerChanged = previousOwnerId !== nextOwnerId;
      if (ownerChanged) ownerGenerationRef.current += 1;
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (!nextSession) {
        bootstrapGenerationRef.current += 1;
        commitData(null);
        setStatus("anonymous");
        setError(null);
        return;
      }
      const hasCurrentOwnerData = dataRef.current?.profile.id === nextSession.user.id;
      if (ownerChanged && !hasCurrentOwnerData) {
        commitData(null);
      }
      // Supabase rotates access tokens within the same authenticated owner. The
      // token used by future requests must update immediately, but mounted UI
      // may hold deliberately non-persistent state such as one-time kit codes.
      // Existing owner data therefore stays mounted; only a missing bootstrap
      // or an actual owner transition enters the loading boundary.
      if (!ownerChanged && hasCurrentOwnerData) return;
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
      ownerGenerationRef.current += 1;
      bootstrapGenerationRef.current += 1;
      subscription.unsubscribe();
    };
  }, [commitData, loadBootstrap, supabase]);

  const requireClient = useCallback((): SupabaseClient => {
    if (!supabase) throw new Error("Account services are still loading.");
    return supabase;
  }, [supabase]);

  const mutationApi = useCallback(
    (scope: IdentityMutationScope) => new FirelightApi(() => scope.accessToken),
    [],
  );

  const refresh = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error("Sign in to continue.");
    const bootstrap = await loadBootstrap(activeSession);
    if (!bootstrap) throw new Error("Your session changed while Firelight refreshed progress.");
    return bootstrap;
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
      async getAccountExport() {
        const scope = captureMutationScope();
        const accountExport = await mutationApi(scope).getAccountExport();
        assertCurrentMutationScope(scope);
        if (accountExport.data.profile.id !== scope.ownerId) {
          throw new Error("Firelight rejected account data for another owner.");
        }
        return accountExport;
      },
      async updateProfile(displayName: string) {
        const scope = captureMutationScope();
        const profile = await mutationApi(scope).updateProfile(displayName);
        assertCurrentMutationScope(scope);
        commitData((current) => (current ? { ...current, profile } : current));
        return profile;
      },
      async claimKit(code: string) {
        const scope = captureMutationScope();
        const activation = await mutationApi(scope).claimKit(code);
        assertCurrentMutationScope(scope);
        await refresh();
        return activation;
      },
      async saveProgress(lessonId: LessonSlug, input: ProgressUpdateInput) {
        const scope = captureMutationScope();
        const progress = await mutationApi(scope).saveProgress(lessonId, input);
        assertCurrentMutationScope(scope);
        commitData((current) => {
          if (!current) return current;
          const nextProgress = mergeProgressCache(current.progress, progress);
          return nextProgress === current.progress
            ? current
            : { ...current, progress: nextProgress };
        });
        return progress;
      },
      async deleteAccount(confirmation: "DELETE") {
        const scope = captureMutationScope();
        await mutationApi(scope).deleteAccount(confirmation);
        purgeBrowserProgressDraftsForOwner(scope.ownerId);
        if (!mutationScopeIsCurrent(scope)) {
          throw new Error("Your account changed after Firelight deleted the requested account.");
        }
        await requireClient().auth.signOut({ scope: "local" });
        ownerGenerationRef.current += 1;
        sessionRef.current = null;
        bootstrapGenerationRef.current += 1;
        setSession(null);
        commitData(null);
        setStatus("anonymous");
      },
    }),
    [
      assertCurrentMutationScope,
      captureMutationScope,
      commitData,
      data,
      error,
      notice,
      recoveryMode,
      refresh,
      requireClient,
      session,
      status,
      supabase,
      mutationApi,
      mutationScopeIsCurrent,
    ],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
