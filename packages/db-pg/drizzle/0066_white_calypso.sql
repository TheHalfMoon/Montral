CREATE TABLE "managed_probe_registration" (
	"region" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"state" text DEFAULT 'registered' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_probe_registration_region_chk" CHECK ("managed_probe_registration"."region" ~ '^[a-z0-9][a-z0-9-]{1,23}$' and "managed_probe_registration"."region" <> 'auto'),
	CONSTRAINT "managed_probe_registration_name_chk" CHECK (char_length(trim("managed_probe_registration"."display_name")) between 1 and 60),
	CONSTRAINT "managed_probe_registration_endpoint_chk" CHECK (char_length("managed_probe_registration"."endpoint_url") between 1 and 2048 and "managed_probe_registration"."endpoint_url" ~ '^https://'),
	CONSTRAINT "managed_probe_registration_state_chk" CHECK ("managed_probe_registration"."state" in ('registered','suspended','revoked')),
	CONSTRAINT "managed_probe_registration_created_by_chk" CHECK (char_length("managed_probe_registration"."created_by") between 1 and 200),
	CONSTRAINT "managed_probe_registration_updated_by_chk" CHECK (char_length("managed_probe_registration"."updated_by") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "managed_probe_registration_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"action" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_probe_registration_event_region_chk" CHECK (char_length("managed_probe_registration_event"."region") between 2 and 24),
	CONSTRAINT "managed_probe_registration_event_action_chk" CHECK ("managed_probe_registration_event"."action" in ('register','suspend','restore','revoke')),
	CONSTRAINT "managed_probe_registration_event_operator_chk" CHECK (char_length("managed_probe_registration_event"."operator_id") between 1 and 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "managed_probe_registration_endpoint_unique" ON "managed_probe_registration" USING btree ("endpoint_url");--> statement-breakpoint
CREATE INDEX "managed_probe_registration_state_region_idx" ON "managed_probe_registration" USING btree ("state","region");--> statement-breakpoint
CREATE INDEX "managed_probe_registration_event_region_id_idx" ON "managed_probe_registration_event" USING btree ("region","id");--> statement-breakpoint
-- Registration actions are operator evidence. Ordinary application and maintenance paths cannot rewrite or erase them.
CREATE FUNCTION montral_managed_probe_registration_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  RAISE EXCEPTION 'managed_probe_registration_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_registration_event_guard_trigger
BEFORE UPDATE OR DELETE ON public.managed_probe_registration_event FOR EACH ROW
EXECUTE FUNCTION montral_managed_probe_registration_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_managed_probe_registration_event_no_truncate_trigger
BEFORE TRUNCATE ON public.managed_probe_registration_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_managed_probe_registration_event_guard();
