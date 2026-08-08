-- Learners may read only the non-secret projection of their own current kit
-- activation. Inventory state, claimant fields, code HMACs, and hash versions
-- remain unavailable to the browser role.
create policy kit_codes_select_own_safe_activation
on public.kit_codes for select
to authenticated
using (
  claimed_by = (select auth.uid())
  and kind = 'code'
  and state = 'claimed'
  and revoked_at is null
);

grant select (id, batch, kind, claimed_at)
on public.kit_codes
to authenticated;

comment on policy kit_codes_select_own_safe_activation on public.kit_codes is
  'Owner-only RLS for the account-export activation projection; secret and inventory columns remain ungranted.';
