CREATE TABLE "managed_probe_enrollment_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"version_id" uuid NOT NULL,
	"endpoint_url" text NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"nonce_digest" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "managed_probe_enrollment_grant_digest_chk" CHECK (octet_length("managed_probe_enrollment_grant"."token_digest") = 32 and octet_length("managed_probe_enrollment_grant"."nonce_digest") = 32),
	CONSTRAINT "managed_probe_enrollment_grant_endpoint_chk" CHECK (char_length("managed_probe_enrollment_grant"."endpoint_url") between 1 and 2048 and "managed_probe_enrollment_grant"."endpoint_url" ~ '^https://'),
	CONSTRAINT "managed_probe_enrollment_grant_state_chk" CHECK (("managed_probe_enrollment_grant"."state" = 'issued' and "managed_probe_enrollment_grant"."consumed_at" is null) or ("managed_probe_enrollment_grant"."state" = 'consumed' and "managed_probe_enrollment_grant"."consumed_at" is not null) or ("managed_probe_enrollment_grant"."state" in ('expired','revoked') and "managed_probe_enrollment_grant"."consumed_at" is null)),
	CONSTRAINT "managed_probe_enrollment_grant_created_by_chk" CHECK (char_length("managed_probe_enrollment_grant"."created_by") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "managed_probe_enrollment_grant_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"region" text NOT NULL,
	"version_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_probe_enrollment_grant_event_region_chk" CHECK (char_length("managed_probe_enrollment_grant_event"."region") between 2 and 24),
	CONSTRAINT "managed_probe_enrollment_grant_event_action_chk" CHECK ("managed_probe_enrollment_grant_event"."action" in ('issue','consume','expire','revoke')),
	CONSTRAINT "managed_probe_enrollment_grant_event_actor_chk" CHECK (char_length("managed_probe_enrollment_grant_event"."actor_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "managed_probe_enrollment_grant" ADD CONSTRAINT "managed_probe_enrollment_grant_credential_fk" FOREIGN KEY ("region","version_id") REFERENCES "public"."managed_probe_credential"("region","version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_probe_enrollment_grant_token_digest_unique" ON "managed_probe_enrollment_grant" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_probe_enrollment_grant_one_issued_per_region_unique" ON "managed_probe_enrollment_grant" USING btree ("region") WHERE "managed_probe_enrollment_grant"."state" = 'issued';--> statement-breakpoint
CREATE INDEX "managed_probe_enrollment_grant_expiry_idx" ON "managed_probe_enrollment_grant" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "managed_probe_enrollment_grant_event_region_id_idx" ON "managed_probe_enrollment_grant_event" USING btree ("region","id");
--> statement-breakpoint
-- Enrollment authorization material is immutable; only an issued grant may reach a terminal state.
CREATE FUNCTION montral_managed_probe_enrollment_grant_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'managed_probe_enrollment_grant is retained for audit' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.region IS DISTINCT FROM NEW.region
     OR OLD.version_id IS DISTINCT FROM NEW.version_id
     OR OLD.endpoint_url IS DISTINCT FROM NEW.endpoint_url
     OR OLD.token_digest IS DISTINCT FROM NEW.token_digest
     OR OLD.nonce_digest IS DISTINCT FROM NEW.nonce_digest
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.state <> 'issued'
     OR NEW.state NOT IN ('consumed', 'expired', 'revoked')
     OR (NEW.state = 'consumed' AND NEW.consumed_at IS NULL)
     OR (NEW.state <> 'consumed' AND NEW.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid managed_probe_enrollment_grant transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_enrollment_grant_guard_trigger
BEFORE UPDATE OR DELETE ON public.managed_probe_enrollment_grant FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_enrollment_grant_guard();
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_enrollment_grant_no_truncate_trigger
BEFORE TRUNCATE ON public.managed_probe_enrollment_grant FOR EACH STATEMENT
EXECUTE FUNCTION montral_managed_probe_enrollment_grant_guard();
--> statement-breakpoint
-- Grant audit records contain identity and outcome only, never token/nonce material.
CREATE FUNCTION montral_managed_probe_enrollment_grant_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  RAISE EXCEPTION 'managed_probe_enrollment_grant_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_enrollment_grant_event_guard_trigger
BEFORE UPDATE OR DELETE ON public.managed_probe_enrollment_grant_event FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_enrollment_grant_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_enrollment_event_truncate_guard
BEFORE TRUNCATE ON public.managed_probe_enrollment_grant_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_managed_probe_enrollment_grant_event_guard();
