CREATE TABLE IF NOT EXISTS "probe_region_state" (
	"region" text PRIMARY KEY NOT NULL,
	"drained" boolean DEFAULT false NOT NULL,
	"drained_at" timestamp with time zone,
	"drained_by" text,
	"drain_note" text,
	"last_answer_at" timestamp with time zone,
	"last_unreachable_at" timestamp with time zone,
	"last_unreachable_reason" text,
	"unreachable_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_region_state_region_chk" CHECK (char_length("probe_region_state"."region") between 1 and 24),
	CONSTRAINT "probe_region_state_note_chk" CHECK ("probe_region_state"."drain_note" is null or char_length("probe_region_state"."drain_note") <= 200),
	CONSTRAINT "probe_region_state_reason_chk" CHECK ("probe_region_state"."last_unreachable_reason" is null or char_length("probe_region_state"."last_unreachable_reason") <= 120)
);
