CREATE TABLE "workspace_operator_audit" (
	"audit_event_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	CONSTRAINT "workspace_operator_audit_operator_chk" CHECK (char_length("workspace_operator_audit"."operator_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "workspace_operator_audit" ADD CONSTRAINT "workspace_operator_audit_audit_event_id_audit_event_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_event"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Private attribution is immutable. Only the guarded parent event's retention
-- or workspace-deletion cascade can erase it. No backfill from mutable state.
CREATE FUNCTION montral_workspace_operator_audit_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $montral$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.audit_event WHERE id = OLD.audit_event_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace_operator_audit is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_workspace_operator_audit_guard_trigger
BEFORE UPDATE OR DELETE ON public.workspace_operator_audit FOR EACH ROW
EXECUTE FUNCTION montral_workspace_operator_audit_guard();
--> statement-breakpoint
CREATE TRIGGER montral_workspace_operator_audit_no_truncate_trigger
BEFORE TRUNCATE ON public.workspace_operator_audit FOR EACH STATEMENT
EXECUTE FUNCTION montral_workspace_operator_audit_guard();
