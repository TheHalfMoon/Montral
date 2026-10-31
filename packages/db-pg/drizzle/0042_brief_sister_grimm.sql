CREATE TABLE "monthly_report_reconciliation" (
	"organization_id" text NOT NULL,
	"report_month" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"actor_user_id" text,
	"previous_state" text NOT NULL,
	"decision" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_report_reconciliation_pk" PRIMARY KEY("organization_id","report_month","recipient_user_id"),
	CONSTRAINT "monthly_report_reconciliation_month_chk" CHECK ("monthly_report_reconciliation"."report_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "monthly_report_reconciliation_prev_chk" CHECK ("monthly_report_reconciliation"."previous_state" in ('attempted','uncertain')),
	CONSTRAINT "monthly_report_reconciliation_decision_chk" CHECK ("monthly_report_reconciliation"."decision" in ('provider_accepted','unresolved')),
	CONSTRAINT "monthly_report_reconciliation_sha_chk" CHECK ("monthly_report_reconciliation"."evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "monthly_report_reconciliation" ADD CONSTRAINT "monthly_report_reconciliation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_report_reconciliation" ADD CONSTRAINT "monthly_report_reconciliation_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_report_reconciliation" ADD CONSTRAINT "monthly_report_reconciliation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monthly_report_reconciliation_org_month_idx" ON "monthly_report_reconciliation" USING btree ("organization_id","report_month");