CREATE TABLE "app_admin_bootstrap_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operator" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_admin_bootstrap_operator" CHECK (length(btrim("app_admin_bootstrap_audit"."operator")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "app_admin_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before_status" text NOT NULL,
	"after_status" text NOT NULL,
	"reason" text,
	"revision" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_admin_decisions_revision" CHECK ("app_admin_decisions"."revision" > 0),
	CONSTRAINT "app_admin_decisions_hash" CHECK ("app_admin_decisions"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_admin_decisions_transition" CHECK (("app_admin_decisions"."action" = 'approve' AND "app_admin_decisions"."before_status" = 'pending' AND "app_admin_decisions"."after_status" = 'approved') OR ("app_admin_decisions"."action" = 'reject' AND "app_admin_decisions"."before_status" = 'pending' AND "app_admin_decisions"."after_status" = 'rejected') OR ("app_admin_decisions"."action" = 'suspend' AND "app_admin_decisions"."role" = 'verifier' AND "app_admin_decisions"."before_status" = 'approved' AND "app_admin_decisions"."after_status" = 'suspended') OR ("app_admin_decisions"."action" = 'restore' AND "app_admin_decisions"."role" = 'verifier' AND "app_admin_decisions"."before_status" = 'suspended' AND "app_admin_decisions"."after_status" = 'approved')),
	CONSTRAINT "app_admin_decisions_reason" CHECK ("app_admin_decisions"."action" NOT IN ('reject', 'suspend') OR ("app_admin_decisions"."reason" IS NOT NULL AND length(btrim("app_admin_decisions"."reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "app_admin_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"recipient_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempt_id" uuid,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_admin_notifications_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "app_admin_notifications_status" CHECK ("app_admin_notifications"."status" IN ('pending', 'sending', 'sent', 'failed', 'blocked', 'uncertain')),
	CONSTRAINT "app_admin_notifications_attempts" CHECK ("app_admin_notifications"."attempts" >= 0),
	CONSTRAINT "app_admin_notifications_sending" CHECK ("app_admin_notifications"."status" <> 'sending' OR ("app_admin_notifications"."attempt_id" IS NOT NULL AND "app_admin_notifications"."claimed_at" IS NOT NULL AND "app_admin_notifications"."recipient_email" IS NOT NULL)),
	CONSTRAINT "app_admin_notifications_sent" CHECK (("app_admin_notifications"."status" = 'sent') = ("app_admin_notifications"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "app_organization_applications" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_admin_bootstrap_audit" ADD CONSTRAINT "app_admin_bootstrap_audit_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_admin_decisions" ADD CONSTRAINT "app_admin_decisions_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_admin_decisions" ADD CONSTRAINT "app_admin_decisions_application_fk" FOREIGN KEY ("organization_id","role") REFERENCES "public"."app_organization_applications"("organization_id","role") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_admin_notifications" ADD CONSTRAINT "app_admin_notifications_decision_id_app_admin_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."app_admin_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_admin_notifications" ADD CONSTRAINT "app_admin_notifications_recipient_user_id_app_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_admin_decisions_idempotency_uq" ON "app_admin_decisions" USING btree ("actor_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "app_admin_decisions_revision_uq" ON "app_admin_decisions" USING btree ("organization_id","role","revision");--> statement-breakpoint
CREATE INDEX "app_admin_decisions_history_idx" ON "app_admin_decisions" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "app_admin_notifications_queue_idx" ON "app_admin_notifications" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "app_organization_applications" ADD CONSTRAINT "app_organization_applications_revision" CHECK ("app_organization_applications"."revision" >= 0);