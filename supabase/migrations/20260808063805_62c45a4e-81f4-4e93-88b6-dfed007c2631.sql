REVOKE ALL ON FUNCTION public.owns_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_tenant(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;