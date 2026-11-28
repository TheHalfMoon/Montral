ALTER TABLE "managed_probe_enrollment_grant" ADD COLUMN "signed_envelope" jsonb;
--> statement-breakpoint
-- Retain the exact public grant bytes across API restarts; never mutate them after issuance.
CREATE FUNCTION montral_managed_probe_enrollment_grant_envelope_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  IF OLD.signed_envelope IS DISTINCT FROM NEW.signed_envelope THEN
    RAISE EXCEPTION 'managed probe enrollment envelope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_enrollment_grant_envelope_guard_trigger
BEFORE UPDATE ON public.managed_probe_enrollment_grant FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_enrollment_grant_envelope_guard();
