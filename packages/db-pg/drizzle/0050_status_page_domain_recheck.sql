ALTER TABLE "status_page" ADD COLUMN "custom_domain_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "custom_domain_failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "custom_domain_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "custom_domain_check_error" text;