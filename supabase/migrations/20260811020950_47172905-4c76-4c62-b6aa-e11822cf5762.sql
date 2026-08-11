REVOKE EXECUTE ON FUNCTION public.claim_sync_jobs(integer) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) FROM authenticated, anon, public;

GRANT EXECUTE ON FUNCTION public.claim_sync_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) TO service_role;