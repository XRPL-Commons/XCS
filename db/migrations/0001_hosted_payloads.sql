CREATE TABLE "hosted_payload_publications" (
	"transaction_hash" text PRIMARY KEY NOT NULL,
	"locator" text NOT NULL,
	"profile_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"schema_uid" text NOT NULL,
	"requester_ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_payload_publications_tx_hash" CHECK ("hosted_payload_publications"."transaction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hosted_payload_publications_issuer" CHECK ("hosted_payload_publications"."issuer" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "hosted_payload_publications_subject" CHECK ("hosted_payload_publications"."subject" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "hosted_payload_publications_schema" CHECK ("hosted_payload_publications"."schema_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hosted_payload_publications_ip_hash" CHECK ("hosted_payload_publications"."requester_ip_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "hosted_payloads" (
	"locator" text PRIMARY KEY NOT NULL,
	"digest_hex" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_payloads_digest_hex_unique" UNIQUE("digest_hex"),
	CONSTRAINT "hosted_payloads_locator" CHECK ("hosted_payloads"."locator" ~ '^[0-9a-f]{20}$'),
	CONSTRAINT "hosted_payloads_digest" CHECK ("hosted_payloads"."digest_hex" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hosted_payloads_size" CHECK (octet_length("hosted_payloads"."content") BETWEEN 1 AND 65536)
);
--> statement-breakpoint
ALTER TABLE "hosted_payload_publications" ADD CONSTRAINT "hosted_payload_publications_locator_hosted_payloads_locator_fk" FOREIGN KEY ("locator") REFERENCES "public"."hosted_payloads"("locator") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_payload_publications" ADD CONSTRAINT "hosted_payload_publications_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_payload_publications" ADD CONSTRAINT "hosted_payload_publications_schema_fk" FOREIGN KEY ("profile_id","schema_uid") REFERENCES "public"."schemas"("profile_id","schema_uid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosted_payload_publications_wallet_quota_idx" ON "hosted_payload_publications" USING btree ("issuer","created_at");--> statement-breakpoint
CREATE INDEX "hosted_payload_publications_ip_quota_idx" ON "hosted_payload_publications" USING btree ("requester_ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "hosted_payload_publications_locator_idx" ON "hosted_payload_publications" USING btree ("locator");