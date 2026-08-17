-- Store a master-key sealed copy of the raw API token so operators can
-- re-show/copy it later. Nullable: tokens issued before this migration only
-- have the SHA-256 hash and cannot be recovered.
ALTER TABLE public.api_tokens
  ADD COLUMN IF NOT EXISTS token_enc TEXT;