CREATE TABLE "operator_mfa_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_suspension" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"suspended_by" text,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_suspension_reason_chk" CHECK ("workspace_suspension"."reason" in ('abuse', 'payment', 'legal', 'operator')),
	CONSTRAINT "workspace_suspension_note_chk" CHECK ("workspace_suspension"."note" is null or char_length("workspace_suspension"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "operator_mfa_session" ADD CONSTRAINT "operator_mfa_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_suspension" ADD CONSTRAINT "workspace_suspension_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;