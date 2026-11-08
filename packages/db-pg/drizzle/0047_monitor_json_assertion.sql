ALTER TABLE "monitor" ADD COLUMN "json_path" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "json_expected" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "json_match" text DEFAULT 'equals' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_json_match_chk" CHECK ("monitor"."json_match" in ('equals', 'contains', 'exists'));