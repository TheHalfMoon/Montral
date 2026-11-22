CREATE TABLE "probe_region_validation_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"outcome" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_region_validation_event_region_chk" CHECK (char_length("probe_region_validation_event"."region") between 1 and 24),
	CONSTRAINT "probe_region_validation_event_outcome_chk" CHECK ("probe_region_validation_event"."outcome" in ('validated','identity_mismatch','credential_mismatch','unavailable')),
	CONSTRAINT "probe_region_validation_event_operator_chk" CHECK (char_length("probe_region_validation_event"."operator_id") between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX "probe_region_validation_event_region_id_idx" ON "probe_region_validation_event" USING btree ("region","id");
--> statement-breakpoint
-- Validation outcomes are operator audit evidence. Application and accidental SQL paths cannot rewrite or erase it.
CREATE FUNCTION montral_probe_region_validation_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  RAISE EXCEPTION 'probe_region_validation_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_probe_region_validation_event_guard_trigger
BEFORE UPDATE OR DELETE ON public.probe_region_validation_event FOR EACH ROW
EXECUTE FUNCTION montral_probe_region_validation_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_probe_region_validation_event_no_truncate_trigger
BEFORE TRUNCATE ON public.probe_region_validation_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_probe_region_validation_event_guard();
