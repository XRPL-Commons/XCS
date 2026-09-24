CREATE TABLE "app_invite_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_invite_deliveries_status" CHECK ("app_invite_deliveries"."status" IN ('sending', 'sent', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "app_invite_deliveries_kind" CHECK ("app_invite_deliveries"."kind" IN ('invitation', 'issued', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "app_issuer_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locator" text NOT NULL,
	"invite_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"subject_address" text NOT NULL,
	"canonical_payload" text NOT NULL,
	"payload_digest" text NOT NULL,
	"credential_uri" text NOT NULL,
	"visibility" text NOT NULL,
	"public_fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_issuer_payloads_locator_unique" UNIQUE("locator"),
	CONSTRAINT "app_issuer_payloads_locator" CHECK ("app_issuer_payloads"."locator" ~ '^[0-9a-f]{18}$'),
	CONSTRAINT "app_issuer_payloads_digest" CHECK ("app_issuer_payloads"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_issuer_payloads_size" CHECK (octet_length("app_issuer_payloads"."canonical_payload") BETWEEN 1 AND 1048576),
	CONSTRAINT "app_issuer_payloads_visibility" CHECK ("app_issuer_payloads"."visibility" IN ('public', 'private')),
	CONSTRAINT "app_issuer_payloads_fields" CHECK (jsonb_typeof("app_issuer_payloads"."public_fields") = 'array' AND NOT jsonb_path_exists("app_issuer_payloads"."public_fields", '$[*] ? (@.type() != "string")'))
);
--> statement-breakpoint
ALTER TABLE "app_invite_deliveries" ADD CONSTRAINT "app_invite_deliveries_invite_id_app_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."app_invites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_issuer_payloads" ADD CONSTRAINT "app_issuer_payloads_invite_id_app_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."app_invites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_issuer_payloads" ADD CONSTRAINT "app_issuer_payloads_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_invite_deliveries_invite_idx" ON "app_invite_deliveries" USING btree ("invite_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_invite_deliveries_event_uq" ON "app_invite_deliveries" USING btree ("invite_id","kind") WHERE "app_invite_deliveries"."kind" <> 'invitation';--> statement-breakpoint
CREATE INDEX "app_issuer_payloads_invite_idx" ON "app_issuer_payloads" USING btree ("invite_id");