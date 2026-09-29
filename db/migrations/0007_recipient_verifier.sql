CREATE TABLE "app_verifier_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verifier_organization_id" uuid NOT NULL,
	"verifier_user_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"scope" text NOT NULL,
	"on_chain" text NOT NULL,
	"schema_status" text NOT NULL,
	"payload_status" text NOT NULL,
	"issuer_trust" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_verifier_history_profile" CHECK (length("app_verifier_history"."profile_id") BETWEEN 1 AND 200),
	CONSTRAINT "app_verifier_history_generation" CHECK ("app_verifier_history"."generation_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_verifier_history_scope" CHECK ("app_verifier_history"."scope" IN ('public', 'full')),
	CONSTRAINT "app_verifier_history_chain" CHECK ("app_verifier_history"."on_chain" IN ('not_found', 'pending', 'active', 'expired', 'deleted')),
	CONSTRAINT "app_verifier_history_schema" CHECK ("app_verifier_history"."schema_status" IN ('valid', 'unknown')),
	CONSTRAINT "app_verifier_history_payload" CHECK ("app_verifier_history"."payload_status" IN ('valid', 'unavailable', 'tampered', 'invalid', 'not_checked')),
	CONSTRAINT "app_verifier_history_trust" CHECK ("app_verifier_history"."issuer_trust" IN ('trusted', 'untrusted', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "app_verifier_history" ADD CONSTRAINT "app_verifier_history_verifier_organization_id_app_organizations_id_fk" FOREIGN KEY ("verifier_organization_id") REFERENCES "public"."app_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_verifier_history" ADD CONSTRAINT "app_verifier_history_verifier_user_id_app_users_id_fk" FOREIGN KEY ("verifier_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_verifier_history" ADD CONSTRAINT "app_verifier_history_presentation_id_app_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."app_presentations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_verifier_history_user_idx" ON "app_verifier_history" USING btree ("verifier_user_id","checked_at","id");--> statement-breakpoint
CREATE INDEX "app_verifier_history_organization_idx" ON "app_verifier_history" USING btree ("verifier_organization_id","checked_at","id");