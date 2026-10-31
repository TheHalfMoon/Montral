CREATE TABLE "monthly_report_recipient" (
	"organization_id" text NOT NULL,
	"report_month" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"locale" text,
	"state" text DEFAULT 'prepared' NOT NULL,
	"attempted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_report_recipient_pk" PRIMARY KEY("organization_id","report_month","recipient_user_id"),
	CONSTRAINT "monthly_report_recipient_state_chk" CHECK ("monthly_report_recipient"."state" in ('prepared', 'attempted', 'accepted', 'uncertain', 'skipped')),
	CONSTRAINT "monthly_report_recipient_month_chk" CHECK ("monthly_report_recipient"."report_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "monthly_report_recipient_attempt_chk" CHECK (("monthly_report_recipient"."state" = 'prepared' and "monthly_report_recipient"."attempted_at" is null and "monthly_report_recipient"."decided_at" is null) or ("monthly_report_recipient"."state" = 'attempted' and "monthly_report_recipient"."attempted_at" is not null and "monthly_report_recipient"."decided_at" is null) or ("monthly_report_recipient"."state" in ('accepted', 'uncertain', 'skipped') and "monthly_report_recipient"."attempted_at" is not null and "monthly_report_recipient"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "monthly_report_recipient" ADD CONSTRAINT "monthly_report_recipient_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_report_recipient" ADD CONSTRAINT "monthly_report_recipient_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monthly_report_recipient_org_month_state_idx" ON "monthly_report_recipient" USING btree ("organization_id","report_month","state");