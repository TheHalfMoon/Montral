CREATE TABLE "managed_probe_credential" (
	"region" text NOT NULL,
	"version_id" uuid NOT NULL,
	"format_version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "managed_probe_credential_pk" PRIMARY KEY("region","version_id"),
	CONSTRAINT "managed_probe_credential_format_chk" CHECK ("managed_probe_credential"."format_version" = 1 and "managed_probe_credential"."algorithm" = 'A256GCM'),
	CONSTRAINT "managed_probe_credential_key_version_chk" CHECK ("managed_probe_credential"."key_version" between 1 and 2147483647),
	CONSTRAINT "managed_probe_credential_nonce_chk" CHECK (octet_length("managed_probe_credential"."nonce") = 12),
	CONSTRAINT "managed_probe_credential_ciphertext_chk" CHECK (octet_length("managed_probe_credential"."ciphertext") = 48),
	CONSTRAINT "managed_probe_credential_state_chk" CHECK (("managed_probe_credential"."state" = 'prepared' and "managed_probe_credential"."revoked_by" is null and "managed_probe_credential"."revoked_at" is null) or ("managed_probe_credential"."state" = 'revoked' and "managed_probe_credential"."revoked_by" is not null and "managed_probe_credential"."revoked_at" is not null)),
	CONSTRAINT "managed_probe_credential_created_by_chk" CHECK (char_length("managed_probe_credential"."created_by") between 1 and 200),
	CONSTRAINT "managed_probe_credential_revoked_by_chk" CHECK ("managed_probe_credential"."revoked_by" is null or char_length("managed_probe_credential"."revoked_by") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "managed_probe_credential_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"version_id" uuid NOT NULL,
	"action" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_probe_credential_event_region_chk" CHECK (char_length("managed_probe_credential_event"."region") between 2 and 24),
	CONSTRAINT "managed_probe_credential_event_action_chk" CHECK ("managed_probe_credential_event"."action" in ('prepare','revoke')),
	CONSTRAINT "managed_probe_credential_event_operator_chk" CHECK (char_length("managed_probe_credential_event"."operator_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "managed_probe_credential" ADD CONSTRAINT "managed_probe_credential_region_managed_probe_registration_region_fk" FOREIGN KEY ("region") REFERENCES "public"."managed_probe_registration"("region") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_probe_credential_one_prepared_per_region_unique" ON "managed_probe_credential" USING btree ("region") WHERE "managed_probe_credential"."state" = 'prepared';--> statement-breakpoint
CREATE INDEX "managed_probe_credential_event_region_id_idx" ON "managed_probe_credential_event" USING btree ("region","id");
--> statement-breakpoint
-- Encrypted material is immutable. The only supported row transition is prepared -> revoked.
CREATE FUNCTION montral_managed_probe_credential_guard() RETURNS trigger
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
     OR OLD.state <> 'prepared'
     OR NEW.state <> 'revoked'
     OR NEW.revoked_by IS NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'invalid managed_probe_credential transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_credential_guard_trigger
BEFORE UPDATE OR DELETE ON public.managed_probe_credential FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_credential_guard();
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_credential_no_truncate_trigger
BEFORE TRUNCATE ON public.managed_probe_credential FOR EACH STATEMENT
EXECUTE FUNCTION montral_managed_probe_credential_guard();
--> statement-breakpoint
-- Credential audit records are append-only and never include nonce, ciphertext, or plaintext.
CREATE FUNCTION montral_managed_probe_credential_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  RAISE EXCEPTION 'managed_probe_credential_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_credential_event_guard_trigger
BEFORE UPDATE OR DELETE ON public.managed_probe_credential_event FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_credential_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_credential_event_no_truncate_trigger
BEFORE TRUNCATE ON public.managed_probe_credential_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_managed_probe_credential_event_guard();
