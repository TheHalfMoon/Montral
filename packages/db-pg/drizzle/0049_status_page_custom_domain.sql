ALTER TABLE "status_page" ADD COLUMN "custom_domain_token" text;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "custom_domain_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_custom_domain_verified_idx" ON "status_page" USING btree ("custom_domain") WHERE "status_page"."custom_domain_verified_at" is not null;