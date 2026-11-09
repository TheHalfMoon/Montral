ALTER TABLE "alert_delivery" ADD COLUMN "status_page_id" uuid;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "checked_through_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_delivery_dedupe_idx" ON "alert_delivery" USING btree ("dedupe_key") WHERE "alert_delivery"."dedupe_key" is not null;