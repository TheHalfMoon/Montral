CREATE TABLE "escalation_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalation_policy_repeat_chk" CHECK ("escalation_policy"."repeat_count" between 0 and 5),
	CONSTRAINT "escalation_policy_version_chk" CHECK ("escalation_policy"."version" >= 1),
	CONSTRAINT "escalation_policy_steps_chk" CHECK (jsonb_typeof("escalation_policy"."steps") = 'array')
);
--> statement-breakpoint
CREATE TABLE "oncall_calendar_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oncall_layer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"user_ids" text[] DEFAULT '{}' NOT NULL,
	"rotation_type" text NOT NULL,
	"shift_length_hours" integer,
	"handoff_time" text NOT NULL,
	"handoff_weekday" integer,
	"start_date" text NOT NULL,
	"restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oncall_layer_rotation_chk" CHECK ("oncall_layer"."rotation_type" in ('daily', 'weekly', 'custom')),
	CONSTRAINT "oncall_layer_shift_chk" CHECK (("oncall_layer"."rotation_type" <> 'custom' and "oncall_layer"."shift_length_hours" is null) or ("oncall_layer"."rotation_type" = 'custom' and "oncall_layer"."shift_length_hours" between 1 and 2016)),
	CONSTRAINT "oncall_layer_handoff_chk" CHECK ("oncall_layer"."handoff_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "oncall_layer_weekday_chk" CHECK ("oncall_layer"."handoff_weekday" is null or "oncall_layer"."handoff_weekday" between 0 and 6),
	CONSTRAINT "oncall_layer_start_chk" CHECK ("oncall_layer"."start_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "oncall_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oncall_override_span_chk" CHECK ("oncall_override"."ends_at" > "oncall_override"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "oncall_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"time_zone" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oncall_schedule_version_chk" CHECK ("oncall_schedule"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "escalation_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "escalation_policy" ADD CONSTRAINT "escalation_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policy" ADD CONSTRAINT "escalation_policy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_calendar_token" ADD CONSTRAINT "oncall_calendar_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_calendar_token" ADD CONSTRAINT "oncall_calendar_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_layer" ADD CONSTRAINT "oncall_layer_schedule_id_oncall_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_override" ADD CONSTRAINT "oncall_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_override" ADD CONSTRAINT "oncall_override_schedule_id_oncall_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_override" ADD CONSTRAINT "oncall_override_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_override" ADD CONSTRAINT "oncall_override_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_schedule" ADD CONSTRAINT "oncall_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_schedule" ADD CONSTRAINT "oncall_schedule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escalation_policy_org_idx" ON "escalation_policy" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oncall_calendar_token_hash_idx" ON "oncall_calendar_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oncall_calendar_token_user_idx" ON "oncall_calendar_token" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "oncall_layer_schedule_idx" ON "oncall_layer" USING btree ("schedule_id","position");--> statement-breakpoint
CREATE INDEX "oncall_override_schedule_idx" ON "oncall_override" USING btree ("schedule_id","ends_at");--> statement-breakpoint
CREATE INDEX "oncall_schedule_org_idx" ON "oncall_schedule" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_escalation_policy_id_escalation_policy_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."escalation_policy"("id") ON DELETE set null ON UPDATE no action;