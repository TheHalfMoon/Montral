ALTER TYPE "public"."monitor_type" ADD VALUE 'browser';--> statement-breakpoint
CREATE TABLE "browser_check_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"failed_step" integer,
	"error" text,
	"duration_ms" integer NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_requests" integer DEFAULT 0 NOT NULL,
	"peak_rss_mb" integer,
	"cpu_ms" integer,
	"screenshot" "bytea",
	"kind" text DEFAULT 'run' NOT NULL,
	"used_secrets" boolean DEFAULT false NOT NULL,
	CONSTRAINT "browser_check_run_screenshot_size_chk" CHECK (octet_length("browser_check_run"."screenshot") <= 204800),
	CONSTRAINT "browser_check_run_kind_chk" CHECK ("browser_check_run"."kind" in ('run', 'deferred', 'error'))
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "browser" jsonb;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "browser_secrets" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "unchecked_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "unchecked_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "browser_secrets_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "deferred_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "last_deferred_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_check_run" ADD CONSTRAINT "browser_check_run_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_check_run_monitor_time_idx" ON "browser_check_run" USING btree ("monitor_id","created_at");