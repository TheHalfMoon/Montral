CREATE TABLE "monthly_report_content" (
	"organization_id" text NOT NULL,
	"report_month" text NOT NULL,
	"workspace_name" text NOT NULL,
	"components" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_report_content_pk" PRIMARY KEY("organization_id","report_month"),
	CONSTRAINT "monthly_report_content_month_chk" CHECK ("monthly_report_content"."report_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "monthly_report_content_components_chk" CHECK (jsonb_typeof("monthly_report_content"."components")='array' and jsonb_array_length("monthly_report_content"."components")>0),
	CONSTRAINT "monthly_report_content_name_chk" CHECK (length(trim("monthly_report_content"."workspace_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "monthly_report_content" ADD CONSTRAINT "monthly_report_content_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Reports are immutable once frozen, even if a caller bypasses the Repo API.
-- DELETE remains allowed for data-retention and workspace cascade erasure.
CREATE FUNCTION montral_monthly_content_no_update() RETURNS trigger
LANGUAGE plpgsql AS $montral$
BEGIN
  RAISE EXCEPTION 'monthly report content is immutable';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_monthly_content_no_update_trigger
BEFORE UPDATE ON monthly_report_content FOR EACH ROW
EXECUTE FUNCTION montral_monthly_content_no_update();
