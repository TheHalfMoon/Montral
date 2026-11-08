CREATE TABLE "status_page_share_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_page_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "status_page" DROP CONSTRAINT "status_page_visibility_chk";--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "access_password_hash" text;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "access_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_subscriber" ADD COLUMN "access_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page_share_link" ADD CONSTRAINT "status_page_share_link_status_page_id_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_share_link" ADD CONSTRAINT "status_page_share_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_share_link_token_idx" ON "status_page_share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "status_page_share_link_page_idx" ON "status_page_share_link" USING btree ("status_page_id");--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_password_chk" CHECK ("status_page"."visibility" <> 'password' or "status_page"."access_password_hash" is not null);--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_visibility_chk" CHECK ("status_page"."visibility" in ('public', 'members', 'password'));