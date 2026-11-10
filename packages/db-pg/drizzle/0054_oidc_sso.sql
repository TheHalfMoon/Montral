CREATE TABLE "sso_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"token_endpoint" text,
	"default_role" text DEFAULT 'member' NOT NULL,
	"require_sso" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connection_role_chk" CHECK ("sso_connection"."default_role" in ('member', 'admin')),
	CONSTRAINT "sso_connection_issuer_chk" CHECK (length("sso_connection"."issuer") between 8 and 500),
	CONSTRAINT "sso_connection_client_chk" CHECK (length("sso_connection"."client_id") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "sso_credential" (
	"kind" text NOT NULL,
	"credential_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_credential_kind_credential_id_connection_id_pk" PRIMARY KEY("kind","credential_id","connection_id"),
	CONSTRAINT "sso_credential_kind_chk" CHECK ("sso_credential"."kind" in ('api_key'))
);
--> statement-breakpoint
CREATE TABLE "sso_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"check_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_flow" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"binding_hash" text NOT NULL,
	"connection_id" text NOT NULL,
	"organization_id" text,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"intent" text NOT NULL,
	"link_user_id" text,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_flow_intent_chk" CHECK ("sso_flow"."intent" in ('signin', 'link'))
);
--> statement-breakpoint
CREATE TABLE "sso_removal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domain" ADD CONSTRAINT "sso_domain_connection_id_sso_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_removal" ADD CONSTRAINT "sso_removal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_session" ADD CONSTRAINT "sso_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connection_org_uidx" ON "sso_connection" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domain_connection_domain_uidx" ON "sso_domain" USING btree ("connection_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domain_verified_uidx" ON "sso_domain" USING btree ("domain") WHERE "sso_domain"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "sso_flow_expires_idx" ON "sso_flow" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sso_removal_org_email_idx" ON "sso_removal" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "sso_removal_org_account_idx" ON "sso_removal" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_sso_identity_uidx" ON "account" USING btree ("provider_id","account_id") WHERE "account"."provider_id" like 'sso:%';