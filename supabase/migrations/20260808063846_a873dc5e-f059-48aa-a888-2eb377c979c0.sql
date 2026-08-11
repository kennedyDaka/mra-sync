CREATE OR REPLACE FUNCTION public.next_invoice_sequence(_terminal_uid uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE nxt bigint;
BEGIN
  UPDATE public.terminals SET invoice_sequence = invoice_sequence + 1
  WHERE id = _terminal_uid
  RETURNING invoice_sequence INTO nxt;
  RETURN nxt;
END; $$;
REVOKE ALL ON FUNCTION public.next_invoice_sequence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) TO service_role;