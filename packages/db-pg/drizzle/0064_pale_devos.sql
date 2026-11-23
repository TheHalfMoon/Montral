CREATE TABLE "probe_region_lifecycle_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"action" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_region_lifecycle_event_region_chk" CHECK (char_length("probe_region_lifecycle_event"."region") between 1 and 24),
	CONSTRAINT "probe_region_lifecycle_event_action_chk" CHECK ("probe_region_lifecycle_event"."action" in ('activate','deactivate')),
	CONSTRAINT "probe_region_lifecycle_event_operator_chk" CHECK (char_length("probe_region_lifecycle_event"."operator_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "probe_region_state" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "probe_region_lifecycle_event_region_id_idx" ON "probe_region_lifecycle_event" USING btree ("region","id");
--> statement-breakpoint
-- Lifecycle actions are operator evidence. No API or ordinary maintenance path may rewrite or erase them.
CREATE FUNCTION montral_probe_region_lifecycle_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  RAISE EXCEPTION 'probe_region_lifecycle_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_probe_region_lifecycle_event_guard_trigger
BEFORE UPDATE OR DELETE ON public.probe_region_lifecycle_event FOR EACH ROW
EXECUTE FUNCTION montral_probe_region_lifecycle_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_probe_region_lifecycle_event_no_truncate_trigger
BEFORE TRUNCATE ON public.probe_region_lifecycle_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_probe_region_lifecycle_event_guard();
