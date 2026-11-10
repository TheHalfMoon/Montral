CREATE TABLE "scim_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scim_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"given_name" text,
	"family_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scim_token" ADD CONSTRAINT "scim_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_token" ADD CONSTRAINT "scim_token_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_user" ADD CONSTRAINT "scim_user_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_token_hash_idx" ON "scim_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_token_active_org_idx" ON "scim_token" USING btree ("organization_id") WHERE "scim_token"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_org_name_idx" ON "scim_user" USING btree ("organization_id","user_name");--> statement-breakpoint
CREATE INDEX "scim_user_org_user_idx" ON "scim_user" USING btree ("organization_id","user_id");