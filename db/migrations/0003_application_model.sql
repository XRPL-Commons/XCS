CREATE TABLE "app_user_roles" (
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_user_roles_user_id_role_pk" PRIMARY KEY("user_id","role"),
	CONSTRAINT "app_user_roles_role" CHECK ("app_user_roles"."role" IN ('admin', 'recipient'))
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_issuer" text,
	"identity_subject" text,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "app_users_status" CHECK ("app_users"."status" IN ('active', 'suspended', 'deleted')),
	CONSTRAINT "app_users_identity" CHECK (("app_users"."status" <> 'deleted' AND length("app_users"."identity_issuer") > 0 AND "app_users"."identity_issuer" IS NOT NULL AND length("app_users"."identity_subject") > 0 AND "app_users"."identity_subject" IS NOT NULL AND "app_users"."deleted_at" IS NULL) OR ("app_users"."status" = 'deleted' AND "app_users"."identity_issuer" IS NULL AND "app_users"."identity_subject" IS NULL AND "app_users"."email" IS NULL AND "app_users"."email_verified_at" IS NULL AND "app_users"."display_name" IS NULL AND "app_users"."deleted_at" IS NOT NULL)),
	CONSTRAINT "app_users_verified_email" CHECK ("app_users"."email_verified_at" IS NULL OR "app_users"."email" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "app_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"network_id" bigint NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_wallets_network" CHECK ("app_wallets"."network_id" BETWEEN 0 AND 4294967295),
	CONSTRAINT "app_wallets_address" CHECK ("app_wallets"."address" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "app_wallets_revocation" CHECK ("app_wallets"."revoked_at" IS NULL OR "app_wallets"."revoked_at" >= "app_wallets"."verified_at")
);
--> statement-breakpoint
CREATE TABLE "app_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_role" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "app_documents_size" CHECK ("app_documents"."byte_length" > 0),
	CONSTRAINT "app_documents_digest" CHECK ("app_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_documents_storage_key" CHECK (length(btrim("app_documents"."storage_key")) > 0),
	CONSTRAINT "app_documents_review" CHECK ("app_documents"."review_status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "app_organization_applications" (
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"website" text,
	"contact" text,
	"jurisdiction" text,
	"description" text,
	"purpose" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	CONSTRAINT "app_organization_applications_organization_id_role_pk" PRIMARY KEY("organization_id","role"),
	CONSTRAINT "app_organization_applications_role" CHECK ("app_organization_applications"."role" IN ('issuer', 'verifier')),
	CONSTRAINT "app_organization_applications_status" CHECK ("app_organization_applications"."status" IN ('pending', 'approved', 'rejected', 'suspended')),
	CONSTRAINT "app_organization_applications_review" CHECK (("app_organization_applications"."status" = 'pending' AND "app_organization_applications"."reviewed_by" IS NULL AND "app_organization_applications"."reviewed_at" IS NULL AND "app_organization_applications"."review_reason" IS NULL) OR ("app_organization_applications"."status" <> 'pending' AND "app_organization_applications"."reviewed_by" IS NOT NULL AND "app_organization_applications"."reviewed_at" IS NOT NULL AND "app_organization_applications"."reviewed_at" >= "app_organization_applications"."submitted_at")),
	CONSTRAINT "app_organization_applications_reason" CHECK ("app_organization_applications"."status" NOT IN ('rejected', 'suspended') OR ("app_organization_applications"."review_reason" IS NOT NULL AND length(btrim("app_organization_applications"."review_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "app_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"responsible_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_organizations_name" CHECK (length(btrim("app_organizations"."name")) > 0),
	CONSTRAINT "app_organizations_status" CHECK ("app_organizations"."status" IN ('active', 'suspended', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "app_credential_metadata" (
	"profile_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"schema_uid" text NOT NULL,
	"issuer_organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"invite_id" uuid,
	"issuer_address" text NOT NULL,
	"subject_address" text NOT NULL,
	"visibility" text NOT NULL,
	"public_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload_storage_key" text,
	"payload_digest" text NOT NULL,
	"creation_transaction_hash" text NOT NULL,
	"creation_ledger_index" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_credential_metadata_profile_id_generation_id_pk" PRIMARY KEY("profile_id","generation_id"),
	CONSTRAINT "app_credential_metadata_invite_id_unique" UNIQUE("invite_id"),
	CONSTRAINT "app_credential_metadata_recipient_uq" UNIQUE("profile_id","generation_id","recipient_user_id"),
	CONSTRAINT "app_credential_metadata_generation" CHECK ("app_credential_metadata"."generation_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_credential_metadata_addresses" CHECK ("app_credential_metadata"."issuer_address" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$' AND "app_credential_metadata"."subject_address" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "app_credential_metadata_visibility" CHECK ("app_credential_metadata"."visibility" IN ('public', 'private')),
	CONSTRAINT "app_credential_metadata_fields" CHECK (jsonb_typeof("app_credential_metadata"."public_fields") = 'array' AND NOT jsonb_path_exists("app_credential_metadata"."public_fields", '$[*] ? (@.type() != "string")')),
	CONSTRAINT "app_credential_metadata_digest" CHECK ("app_credential_metadata"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_credential_metadata_transaction" CHECK ("app_credential_metadata"."creation_transaction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_credential_metadata_ledger" CHECK ("app_credential_metadata"."creation_ledger_index" BETWEEN 1 AND 4294967295),
	CONSTRAINT "app_credential_metadata_storage" CHECK ("app_credential_metadata"."payload_storage_key" IS NULL OR length(btrim("app_credential_metadata"."payload_storage_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"schema_uid" text NOT NULL,
	"delivery_email" text,
	"token_hash" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "app_invites_claim_identity_uq" UNIQUE("id","organization_id","profile_id","schema_uid","claimed_by"),
	CONSTRAINT "app_invites_token" CHECK ("app_invites"."token_hash" IS NULL OR "app_invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_invites_unclaimed_token" CHECK ("app_invites"."claimed_at" IS NOT NULL OR "app_invites"."revoked_at" IS NOT NULL OR "app_invites"."token_hash" IS NOT NULL),
	CONSTRAINT "app_invites_expiry" CHECK ("app_invites"."expires_at" > "app_invites"."created_at"),
	CONSTRAINT "app_invites_claim" CHECK (("app_invites"."claimed_by" IS NULL AND "app_invites"."claimed_at" IS NULL) OR ("app_invites"."claimed_by" IS NOT NULL AND "app_invites"."claimed_at" IS NOT NULL AND "app_invites"."claimed_at" >= "app_invites"."created_at" AND "app_invites"."claimed_at" < "app_invites"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "app_schema_metadata" (
	"profile_id" text NOT NULL,
	"schema_uid" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text,
	"category" text,
	"registration_transaction_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_schema_metadata_profile_id_schema_uid_pk" PRIMARY KEY("profile_id","schema_uid"),
	CONSTRAINT "app_schema_metadata_owner_uq" UNIQUE("profile_id","schema_uid","organization_id"),
	CONSTRAINT "app_schema_metadata_profile" CHECK (length("app_schema_metadata"."profile_id") > 0),
	CONSTRAINT "app_schema_metadata_uid" CHECK ("app_schema_metadata"."schema_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_schema_metadata_transaction" CHECK ("app_schema_metadata"."registration_transaction_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app_presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"verifier_organization_id" uuid,
	"scope" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_presentations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "app_presentations_scope" CHECK ("app_presentations"."scope" IN ('public', 'full')),
	CONSTRAINT "app_presentations_audience" CHECK ("app_presentations"."scope" <> 'full' OR "app_presentations"."verifier_organization_id" IS NOT NULL),
	CONSTRAINT "app_presentations_token" CHECK ("app_presentations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_presentations_revocation" CHECK ("app_presentations"."revoked_at" IS NULL OR "app_presentations"."revoked_at" >= "app_presentations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_granted_by_app_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_wallets" ADD CONSTRAINT "app_wallets_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_documents" ADD CONSTRAINT "app_documents_uploaded_by_app_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_documents" ADD CONSTRAINT "app_documents_application_fk" FOREIGN KEY ("organization_id","application_role") REFERENCES "public"."app_organization_applications"("organization_id","role") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_organization_applications" ADD CONSTRAINT "app_organization_applications_organization_id_app_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."app_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_organization_applications" ADD CONSTRAINT "app_organization_applications_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_organizations" ADD CONSTRAINT "app_organizations_responsible_user_id_app_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credential_metadata" ADD CONSTRAINT "app_credential_metadata_recipient_user_id_app_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credential_metadata" ADD CONSTRAINT "app_credential_metadata_schema_owner_fk" FOREIGN KEY ("profile_id","schema_uid","issuer_organization_id") REFERENCES "public"."app_schema_metadata"("profile_id","schema_uid","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credential_metadata" ADD CONSTRAINT "app_credential_metadata_invite_claim_fk" FOREIGN KEY ("invite_id","issuer_organization_id","profile_id","schema_uid","recipient_user_id") REFERENCES "public"."app_invites"("id","organization_id","profile_id","schema_uid","claimed_by") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_invites" ADD CONSTRAINT "app_invites_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_invites" ADD CONSTRAINT "app_invites_claimed_by_app_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_invites" ADD CONSTRAINT "app_invites_schema_owner_fk" FOREIGN KEY ("profile_id","schema_uid","organization_id") REFERENCES "public"."app_schema_metadata"("profile_id","schema_uid","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_schema_metadata" ADD CONSTRAINT "app_schema_metadata_organization_id_app_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."app_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_presentations" ADD CONSTRAINT "app_presentations_verifier_organization_id_app_organizations_id_fk" FOREIGN KEY ("verifier_organization_id") REFERENCES "public"."app_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_presentations" ADD CONSTRAINT "app_presentations_recipient_fk" FOREIGN KEY ("profile_id","generation_id","recipient_user_id") REFERENCES "public"."app_credential_metadata"("profile_id","generation_id","recipient_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_identity_uq" ON "app_users" USING btree ("identity_issuer","identity_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "app_wallets_network_address_uq" ON "app_wallets" USING btree ("network_id","address");--> statement-breakpoint
CREATE INDEX "app_wallets_user_idx" ON "app_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_documents_application_idx" ON "app_documents" USING btree ("organization_id","application_role");--> statement-breakpoint
CREATE INDEX "app_organization_applications_queue_idx" ON "app_organization_applications" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "app_organizations_responsible_idx" ON "app_organizations" USING btree ("responsible_user_id");--> statement-breakpoint
CREATE INDEX "app_credential_metadata_recipient_idx" ON "app_credential_metadata" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "app_credential_metadata_issuer_idx" ON "app_credential_metadata" USING btree ("issuer_organization_id","created_at");--> statement-breakpoint
CREATE INDEX "app_invites_organization_idx" ON "app_invites" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "app_invites_claimant_idx" ON "app_invites" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "app_schema_metadata_organization_idx" ON "app_schema_metadata" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "app_presentations_recipient_idx" ON "app_presentations" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "app_presentations_verifier_idx" ON "app_presentations" USING btree ("verifier_organization_id");