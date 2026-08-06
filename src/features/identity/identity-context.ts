import { createContext, useContext } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { LessonSlug } from "../../../shared/curriculum";
import type {
  BootstrapData,
  KitActivation,
  LearnerProfile,
  LessonProgress,
  ProgressUpdateInput,
} from "../../../shared/identity";

export type IdentityStatus = "loading" | "anonymous" | "authenticated" | "error";

export interface IdentityContextValue {
  readonly status: IdentityStatus;
  readonly session: Session | null;
  readonly data: BootstrapData | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly recoveryMode: boolean;
  readonly supabase: SupabaseClient | null;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  refresh(): Promise<void>;
  updateProfile(displayName: string): Promise<LearnerProfile>;
  claimKit(code: string): Promise<KitActivation>;
  saveProgress(lessonId: LessonSlug, input: ProgressUpdateInput): Promise<LessonProgress>;
  deleteAccount(): Promise<void>;
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error("Identity provider is not available."));
}

export const anonymousIdentity: IdentityContextValue = {
  status: "anonymous",
  session: null,
  data: null,
  error: null,
  notice: null,
  recoveryMode: false,
  supabase: null,
  signUp: unavailable,
  signIn: unavailable,
  signOut: unavailable,
  requestPasswordReset: unavailable,
  updatePassword: unavailable,
  refresh: unavailable,
  updateProfile: unavailable,
  claimKit: unavailable,
  saveProgress: unavailable,
  deleteAccount: unavailable,
};

export const IdentityContext = createContext<IdentityContextValue>(anonymousIdentity);

export function useIdentity(): IdentityContextValue {
  return useContext(IdentityContext);
}
