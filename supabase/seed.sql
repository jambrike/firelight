-- Publicly documented local-only code: ABCD-EFGH-JKMP-NRST
-- HMAC key: firelight-local-kit-pepper; message: ABCDEFGHJKMPNRST
insert into public.kit_codes (code_hash, batch)
values (
  '159958faa2079365bf52f59e3198e67401517ebd5a5f0eda3fbacef865db5554',
  'local-pilot'
)
on conflict (hash_version, code_hash) do nothing;
