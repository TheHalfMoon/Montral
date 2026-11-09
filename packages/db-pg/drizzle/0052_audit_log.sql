CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"changes" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_actor_type_chk" CHECK ("audit_event"."actor_type" in ('user', 'api_key', 'system')),
	CONSTRAINT "audit_event_action_chk" CHECK ("audit_event"."action" ~ '^[a-z_]+(\.[a-z_]+)+$' and length("audit_event"."action") <= 64),
	CONSTRAINT "audit_event_changes_chk" CHECK ("audit_event"."changes" is null or (jsonb_typeof("audit_event"."changes") = 'object' and octet_length("audit_event"."changes"::text) <= 4096))
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_org_target_idx" ON "audit_event" USING btree ("organization_id","target_type","target_id");--> statement-breakpoint
-- The audit log is append-only. UPDATE and TRUNCATE are always refused. DELETE is allowed in two cases only:
--   * retention: montral_prune_audit() sets a transaction-local cutoff, and only rows older than that cutoff go; a
--     cutoff less than 30 days old is ignored, so even a hand-set setting cannot erase recent history;
--   * workspace deletion: the organization row is already gone when its FK cascade reaches these rows.
-- This guards against application bugs and stray SQL; the table owner can still drop the trigger.
CREATE FUNCTION montral_audit_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $montral$
DECLARE v_cutoff text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    v_cutoff := current_setting('montral.audit_prune_before', true);
    IF v_cutoff IS NOT NULL AND v_cutoff ~ '^[0-9]+(\.[0-9]+)?$'
       AND to_timestamp(v_cutoff::double precision) <= now() - interval '30 days'
       AND OLD.created_at < to_timestamp(v_cutoff::double precision) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = '42501';
END;
$montral$;
--> statement-breakpoint
CREATE TRIGGER montral_audit_event_guard_trigger
BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW
EXECUTE FUNCTION montral_audit_event_guard();
--> statement-breakpoint
CREATE TRIGGER montral_audit_event_no_truncate_trigger
BEFORE TRUNCATE ON audit_event FOR EACH STATEMENT
EXECUTE FUNCTION montral_audit_event_guard();
--> statement-breakpoint
-- Retention: deletes audit rows older than p_older_than (at least 30 days) and returns how many went.
CREATE FUNCTION montral_prune_audit(p_older_than interval) RETURNS integer
LANGUAGE plpgsql AS $montral$
DECLARE
  v_cutoff timestamptz := date_trunc('second', now() - p_older_than);
  v_count integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < interval '30 days' THEN
    RAISE EXCEPTION 'audit retention must be at least 30 days';
  END IF;
  PERFORM set_config('montral.audit_prune_before', extract(epoch FROM v_cutoff)::text, true);
  DELETE FROM audit_event WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('montral.audit_prune_before', '', true);
  RETURN v_count;
END;
$montral$;
