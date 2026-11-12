CREATE TABLE "probe_region_drain_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"action" text NOT NULL,
	"operator_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_region_drain_event_action_chk" CHECK ("probe_region_drain_event"."action" in ('drain', 'undrain')),
	CONSTRAINT "probe_region_drain_event_region_chk" CHECK (char_length("probe_region_drain_event"."region") between 1 and 24),
	CONSTRAINT "probe_region_drain_event_note_chk" CHECK ("probe_region_drain_event"."note" is null or char_length("probe_region_drain_event"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "probe_region_state" ADD COLUMN "last_undrained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "probe_region_state" ADD COLUMN "last_undrained_by" text;--> statement-breakpoint
CREATE INDEX "probe_region_drain_event_region_id_idx" ON "probe_region_drain_event" USING btree ("region","id");