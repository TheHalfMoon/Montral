ALTER TABLE "managed_probe_credential" DROP CONSTRAINT "managed_probe_credential_state_chk";--> statement-breakpoint
ALTER TABLE "managed_probe_credential_event" DROP CONSTRAINT "managed_probe_credential_event_action_chk";--> statement-breakpoint
DROP INDEX "managed_probe_credential_one_prepared_per_region_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "managed_probe_credential_one_unrevoked_per_region_unique" ON "managed_probe_credential" USING btree ("region") WHERE "managed_probe_credential"."state" in ('prepared', 'verified');--> statement-breakpoint
ALTER TABLE "managed_probe_credential" ADD CONSTRAINT "managed_probe_credential_state_chk" CHECK (("managed_probe_credential"."state" in ('prepared', 'verified') and "managed_probe_credential"."revoked_by" is null and "managed_probe_credential"."revoked_at" is null) or ("managed_probe_credential"."state" = 'revoked' and "managed_probe_credential"."revoked_by" is not null and "managed_probe_credential"."revoked_at" is not null));--> statement-breakpoint
ALTER TABLE "managed_probe_credential_event" ADD CONSTRAINT "managed_probe_credential_event_action_chk" CHECK ("managed_probe_credential_event"."action" in ('prepare','verify','revoke'));
--> statement-breakpoint
-- Proof settlement may promote prepared -> verified; either non-revoked state may only move to revoked afterward.
CREATE OR REPLACE FUNCTION montral_managed_probe_credential_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'managed_probe_credential is retained for audit' USING ERRCODE = '42501';
  END IF;
  IF OLD.region IS DISTINCT FROM NEW.region
     OR OLD.version_id IS DISTINCT FROM NEW.version_id
     OR OLD.format_version IS DISTINCT FROM NEW.format_version
     OR OLD.algorithm IS DISTINCT FROM NEW.algorithm
     OR OLD.key_version IS DISTINCT FROM NEW.key_version
     OR OLD.nonce IS DISTINCT FROM NEW.nonce
     OR OLD.ciphertext IS DISTINCT FROM NEW.ciphertext
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR NOT (
       (OLD.state = 'prepared' AND NEW.state = 'verified' AND NEW.revoked_by IS NULL AND NEW.revoked_at IS NULL)
       OR (OLD.state IN ('prepared', 'verified') AND NEW.state = 'revoked' AND NEW.revoked_by IS NOT NULL AND NEW.revoked_at IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'invalid managed_probe_credential transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$montral$;
