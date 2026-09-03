CREATE TABLE "ledger_checkpoints" (
	"profile_id" text NOT NULL,
	"ledger_index" bigint NOT NULL,
	"ledger_hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"close_time" bigint NOT NULL,
	"transaction_count" integer NOT NULL,
	"transaction_root" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_checkpoints_pk" PRIMARY KEY("profile_id","ledger_index"),
	CONSTRAINT "ledger_checkpoints_index_uint32" CHECK ("ledger_checkpoints"."ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "ledger_checkpoints_hash" CHECK ("ledger_checkpoints"."ledger_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_checkpoints_parent" CHECK ("ledger_checkpoints"."parent_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_checkpoints_close_time_uint32" CHECK ("ledger_checkpoints"."close_time" BETWEEN 0 AND 4294967295),
	CONSTRAINT "ledger_checkpoints_tx_count" CHECK ("ledger_checkpoints"."transaction_count" >= 0),
	CONSTRAINT "ledger_checkpoints_transaction_root" CHECK ("ledger_checkpoints"."transaction_root" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "network_profiles" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"xcs_version" text NOT NULL,
	"network_id" bigint NOT NULL,
	"required_amendment" text NOT NULL,
	"registry_address" text NOT NULL,
	"registration_amount_drops" bigint NOT NULL,
	"activation_ledger_index" bigint NOT NULL,
	"activation_ledger_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_profiles_xcs_version" CHECK ("network_profiles"."xcs_version" = '0.1'),
	CONSTRAINT "network_profiles_network_id" CHECK ("network_profiles"."network_id" BETWEEN 0 AND 4294967295),
	CONSTRAINT "network_profiles_registration_amount" CHECK ("network_profiles"."registration_amount_drops" = 1),
	CONSTRAINT "network_profiles_activation_index" CHECK ("network_profiles"."activation_ledger_index" BETWEEN 1 AND 4294967295),
	CONSTRAINT "network_profiles_activation_hash" CHECK ("network_profiles"."activation_ledger_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "network_profiles_registry_address" CHECK ("network_profiles"."registry_address" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$')
);
--> statement-breakpoint
CREATE TABLE "indexer_incidents" (
	"profile_id" text NOT NULL,
	"writer_epoch" bigint NOT NULL,
	"error_code" text NOT NULL,
	"primary_source_tip" bigint,
	"secondary_source_tip" bigint,
	"last_agreed_ledger_index" bigint,
	"last_agreed_ledger_hash" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_incidents_pk" PRIMARY KEY("profile_id","writer_epoch"),
	CONSTRAINT "indexer_incidents_writer_epoch" CHECK ("indexer_incidents"."writer_epoch" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "indexer_incidents_error_code" CHECK ("indexer_incidents"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "indexer_incidents_primary_tip" CHECK ("indexer_incidents"."primary_source_tip" IS NULL OR "indexer_incidents"."primary_source_tip" BETWEEN 0 AND 4294967295),
	CONSTRAINT "indexer_incidents_secondary_tip" CHECK ("indexer_incidents"."secondary_source_tip" IS NULL OR "indexer_incidents"."secondary_source_tip" BETWEEN 0 AND 4294967295),
	CONSTRAINT "indexer_incidents_agreed_ledger" CHECK (("indexer_incidents"."last_agreed_ledger_index" IS NULL AND "indexer_incidents"."last_agreed_ledger_hash" IS NULL)
          OR ("indexer_incidents"."last_agreed_ledger_index" IS NOT NULL
          AND "indexer_incidents"."last_agreed_ledger_hash" IS NOT NULL
          AND "indexer_incidents"."last_agreed_ledger_index" BETWEEN 0 AND 4294967295
          AND "indexer_incidents"."last_agreed_ledger_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "indexer_status" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"primary_source_tip" bigint,
	"secondary_source_tip" bigint,
	"last_agreed_ledger_index" bigint,
	"last_agreed_ledger_hash" text,
	"error_code" text,
	"writer_id" text,
	"writer_epoch" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_status_state" CHECK ("indexer_status"."state" IN ('starting', 'catching_up', 'ready', 'halted')),
	CONSTRAINT "indexer_status_primary_tip" CHECK ("indexer_status"."primary_source_tip" IS NULL OR "indexer_status"."primary_source_tip" BETWEEN 0 AND 4294967295),
	CONSTRAINT "indexer_status_secondary_tip" CHECK ("indexer_status"."secondary_source_tip" IS NULL OR "indexer_status"."secondary_source_tip" BETWEEN 0 AND 4294967295),
	CONSTRAINT "indexer_status_agreed_ledger" CHECK (("indexer_status"."last_agreed_ledger_index" IS NULL AND "indexer_status"."last_agreed_ledger_hash" IS NULL)
          OR ("indexer_status"."last_agreed_ledger_index" IS NOT NULL
          AND "indexer_status"."last_agreed_ledger_hash" IS NOT NULL
          AND "indexer_status"."last_agreed_ledger_index" BETWEEN 0 AND 4294967295
          AND "indexer_status"."last_agreed_ledger_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "indexer_status_agreed_not_ahead" CHECK ("indexer_status"."state" = 'halted'
          OR "indexer_status"."last_agreed_ledger_index" IS NULL
          OR (("indexer_status"."primary_source_tip" IS NULL OR "indexer_status"."last_agreed_ledger_index" <= "indexer_status"."primary_source_tip")
          AND ("indexer_status"."secondary_source_tip" IS NULL OR "indexer_status"."last_agreed_ledger_index" <= "indexer_status"."secondary_source_tip"))),
	CONSTRAINT "indexer_status_ready_shape" CHECK ("indexer_status"."state" <> 'ready'
          OR ("indexer_status"."primary_source_tip" IS NOT NULL
          AND "indexer_status"."secondary_source_tip" IS NOT NULL
          AND "indexer_status"."last_agreed_ledger_index" IS NOT NULL
          AND "indexer_status"."last_agreed_ledger_hash" IS NOT NULL
          AND "indexer_status"."writer_id" IS NOT NULL
          AND "indexer_status"."lease_expires_at" IS NOT NULL
          AND "indexer_status"."last_agreed_ledger_index" = LEAST("indexer_status"."primary_source_tip", "indexer_status"."secondary_source_tip"))),
	CONSTRAINT "indexer_status_error_code" CHECK ("indexer_status"."error_code" IS NULL OR "indexer_status"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "indexer_status_error_shape" CHECK (("indexer_status"."state" = 'halted' AND "indexer_status"."error_code" IS NOT NULL)
          OR ("indexer_status"."state" <> 'halted' AND "indexer_status"."error_code" IS NULL)),
	CONSTRAINT "indexer_status_writer_id" CHECK ("indexer_status"."writer_id" IS NULL OR "indexer_status"."writer_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "indexer_status_writer_epoch" CHECK ("indexer_status"."writer_epoch" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "indexer_status_lease_window" CHECK (("indexer_status"."writer_id" IS NULL AND "indexer_status"."lease_expires_at" IS NULL)
          OR ("indexer_status"."writer_id" IS NOT NULL
          AND "indexer_status"."lease_expires_at" IS NOT NULL
          AND "indexer_status"."lease_expires_at" >= "indexer_status"."updated_at"
          AND "indexer_status"."lease_expires_at" <= "indexer_status"."updated_at" + interval '5 minutes'))
);
--> statement-breakpoint
CREATE TABLE "schema_events" (
	"profile_id" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"ledger_index" bigint NOT NULL,
	"ledger_hash" text NOT NULL,
	"transaction_index" integer NOT NULL,
	"publisher" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"schema_uid" text,
	"memo_json" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_events_pk" PRIMARY KEY("profile_id","transaction_hash"),
	CONSTRAINT "schema_events_tx_hash" CHECK ("schema_events"."transaction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schema_events_ledger_hash" CHECK ("schema_events"."ledger_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schema_events_ledger_index_uint32" CHECK ("schema_events"."ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "schema_events_tx_index" CHECK ("schema_events"."transaction_index" >= 0),
	CONSTRAINT "schema_events_status" CHECK ("schema_events"."status" IN ('accepted', 'rejected')),
	CONSTRAINT "schema_events_result_shape" CHECK (("schema_events"."status" = 'accepted' AND "schema_events"."schema_uid" IS NOT NULL AND "schema_events"."reason_code" IS NULL AND "schema_events"."memo_json" IS NOT NULL)
          OR ("schema_events"."status" = 'rejected' AND "schema_events"."schema_uid" IS NULL AND "schema_events"."reason_code" IS NOT NULL)),
	CONSTRAINT "schema_events_schema_uid" CHECK ("schema_events"."schema_uid" IS NULL OR "schema_events"."schema_uid" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "schemas" (
	"profile_id" text NOT NULL,
	"schema_uid" text NOT NULL,
	"publisher" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"parent_uid" text,
	"supersedes_uid" text,
	"definition" jsonb NOT NULL,
	"resolved_definition" jsonb NOT NULL,
	"registration_transaction_hash" text NOT NULL,
	"ledger_index" bigint NOT NULL,
	"transaction_index" integer NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schemas_pk" PRIMARY KEY("profile_id","schema_uid"),
	CONSTRAINT "schemas_uid" CHECK ("schemas"."schema_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schemas_parent_uid" CHECK ("schemas"."parent_uid" IS NULL OR "schemas"."parent_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schemas_supersedes_uid" CHECK ("schemas"."supersedes_uid" IS NULL OR "schemas"."supersedes_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schemas_registration_tx_hash" CHECK ("schemas"."registration_transaction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "schemas_ledger_index_uint32" CHECK ("schemas"."ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "schemas_transaction_index" CHECK ("schemas"."transaction_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credential_events" (
	"profile_id" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"node_index" integer NOT NULL,
	"generation_id" text NOT NULL,
	"ledger_object_id" text NOT NULL,
	"ledger_index" bigint NOT NULL,
	"ledger_hash" text NOT NULL,
	"transaction_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"schema_uid" text NOT NULL,
	"uri_hex" text,
	"expiration" bigint,
	"accepted" boolean NOT NULL,
	"deletion_cause" text,
	"snapshot" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_events_pk" PRIMARY KEY("profile_id","transaction_hash","node_index"),
	CONSTRAINT "credential_events_tx_hash" CHECK ("credential_events"."transaction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_events_object" CHECK ("credential_events"."ledger_object_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_events_ledger_hash" CHECK ("credential_events"."ledger_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_events_schema" CHECK ("credential_events"."schema_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_events_node_index" CHECK ("credential_events"."node_index" >= 0),
	CONSTRAINT "credential_events_ledger_index_uint32" CHECK ("credential_events"."ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_events_transaction_index" CHECK ("credential_events"."transaction_index" >= 0),
	CONSTRAINT "credential_events_expiration_uint32" CHECK ("credential_events"."expiration" IS NULL OR "credential_events"."expiration" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_events_type" CHECK ("credential_events"."event_type" IN ('created', 'accepted', 'deleted')),
	CONSTRAINT "credential_events_delete_shape" CHECK (("credential_events"."event_type" = 'deleted' AND "credential_events"."deletion_cause" IS NOT NULL)
          OR ("credential_events"."event_type" <> 'deleted' AND "credential_events"."deletion_cause" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "credential_generations" (
	"profile_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"ledger_object_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"schema_uid" text NOT NULL,
	"uri_hex" text,
	"expiration" bigint,
	"accepted" boolean DEFAULT false NOT NULL,
	"created_ledger_index" bigint NOT NULL,
	"created_transaction_index" integer NOT NULL,
	"last_ledger_index" bigint NOT NULL,
	"deleted_ledger_index" bigint,
	"deletion_cause" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_generations_pk" PRIMARY KEY("profile_id","generation_id"),
	CONSTRAINT "credential_generations_id" CHECK ("credential_generations"."generation_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_generations_object" CHECK ("credential_generations"."ledger_object_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_generations_schema" CHECK ("credential_generations"."schema_uid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credential_generations_expiration_uint32" CHECK ("credential_generations"."expiration" IS NULL OR "credential_generations"."expiration" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_generations_created_ledger_uint32" CHECK ("credential_generations"."created_ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_generations_created_transaction_index" CHECK ("credential_generations"."created_transaction_index" >= 0),
	CONSTRAINT "credential_generations_last_ledger_uint32" CHECK ("credential_generations"."last_ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_generations_deleted_ledger_uint32" CHECK ("credential_generations"."deleted_ledger_index" IS NULL OR "credential_generations"."deleted_ledger_index" BETWEEN 0 AND 4294967295),
	CONSTRAINT "credential_generations_ledger_order" CHECK ("credential_generations"."last_ledger_index" >= "credential_generations"."created_ledger_index"
          AND ("credential_generations"."deleted_ledger_index" IS NULL OR "credential_generations"."deleted_ledger_index" = "credential_generations"."last_ledger_index")),
	CONSTRAINT "credential_generations_deletion" CHECK (("credential_generations"."deleted_ledger_index" IS NULL AND "credential_generations"."deletion_cause" IS NULL)
          OR ("credential_generations"."deleted_ledger_index" IS NOT NULL AND "credential_generations"."deletion_cause" IS NOT NULL)),
	CONSTRAINT "credential_generations_deletion_cause" CHECK ("credential_generations"."deletion_cause" IS NULL OR "credential_generations"."deletion_cause" IN ('issuer_revoked', 'subject_rejected', 'subject_removed', 'expired_cleanup', 'account_deleted', 'self_deleted'))
);
--> statement-breakpoint
CREATE TABLE "demo_pins" (
	"pin_id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"wallet" text NOT NULL,
	"requester_ip_hash" text NOT NULL,
	"cid" text NOT NULL,
	"byte_length" integer NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"unpinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_pins_challenge_id_unique" UNIQUE("challenge_id"),
	CONSTRAINT "demo_pins_id" CHECK ("demo_pins"."pin_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "demo_pins_ip_hash" CHECK ("demo_pins"."requester_ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "demo_pins_wallet" CHECK ("demo_pins"."wallet" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "demo_pins_cid" CHECK ("demo_pins"."cid" ~ '^b[a-z2-7]+$'),
	CONSTRAINT "demo_pins_byte_length" CHECK ("demo_pins"."byte_length" BETWEEN 1 AND 65536),
	CONSTRAINT "demo_pins_status" CHECK ("demo_pins"."status" IN ('pending', 'pinned', 'failed', 'unpinned')),
	CONSTRAINT "demo_pins_failure_shape" CHECK (("demo_pins"."status" = 'failed' AND "demo_pins"."failure_code" IS NOT NULL)
          OR ("demo_pins"."status" <> 'failed' AND "demo_pins"."failure_code" IS NULL)),
	CONSTRAINT "demo_pins_unpinned_shape" CHECK (("demo_pins"."status" = 'unpinned' AND "demo_pins"."unpinned_at" IS NOT NULL)
          OR ("demo_pins"."status" <> 'unpinned' AND "demo_pins"."unpinned_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pin_challenges" (
	"challenge_id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"wallet" text NOT NULL,
	"requester_ip_hash" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pin_challenges_id" CHECK ("pin_challenges"."challenge_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pin_challenges_ip_hash" CHECK ("pin_challenges"."requester_ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pin_challenges_wallet" CHECK ("pin_challenges"."wallet" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "pin_challenges_expiry" CHECK ("pin_challenges"."expires_at" > "pin_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "ledger_checkpoints" ADD CONSTRAINT "ledger_checkpoints_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer_incidents" ADD CONSTRAINT "indexer_incidents_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer_status" ADD CONSTRAINT "indexer_status_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_events" ADD CONSTRAINT "schema_events_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_registration_event_fk" FOREIGN KEY ("profile_id","registration_transaction_hash") REFERENCES "public"."schema_events"("profile_id","transaction_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_schema_fk" FOREIGN KEY ("profile_id","schema_uid") REFERENCES "public"."schemas"("profile_id","schema_uid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_generation_fk" FOREIGN KEY ("profile_id","generation_id") REFERENCES "public"."credential_generations"("profile_id","generation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_generations" ADD CONSTRAINT "credential_generations_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_generations" ADD CONSTRAINT "credential_generations_schema_fk" FOREIGN KEY ("profile_id","schema_uid") REFERENCES "public"."schemas"("profile_id","schema_uid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_pins" ADD CONSTRAINT "demo_pins_challenge_id_pin_challenges_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."pin_challenges"("challenge_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_pins" ADD CONSTRAINT "demo_pins_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_challenges" ADD CONSTRAINT "pin_challenges_profile_id_network_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."network_profiles"("profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_checkpoints_profile_hash_uq" ON "ledger_checkpoints" USING btree ("profile_id","ledger_hash");--> statement-breakpoint
CREATE INDEX "schema_events_ledger_idx" ON "schema_events" USING btree ("profile_id","ledger_index","transaction_index");--> statement-breakpoint
CREATE INDEX "schema_events_activity_idx" ON "schema_events" USING btree ("profile_id","ledger_index","transaction_index","transaction_hash");--> statement-breakpoint
CREATE INDEX "schema_events_publisher_idx" ON "schema_events" USING btree ("profile_id","publisher");--> statement-breakpoint
CREATE UNIQUE INDEX "schemas_registration_tx_uq" ON "schemas" USING btree ("profile_id","registration_transaction_hash");--> statement-breakpoint
CREATE INDEX "schemas_publisher_order_idx" ON "schemas" USING btree ("profile_id","publisher","ledger_index","transaction_index");--> statement-breakpoint
CREATE INDEX "schemas_order_idx" ON "schemas" USING btree ("profile_id","ledger_index","transaction_index","schema_uid");--> statement-breakpoint
CREATE INDEX "schemas_search_idx" ON "schemas" USING gin (to_tsvector('simple', "name" || ' ' || "description"));--> statement-breakpoint
CREATE INDEX "credential_events_generation_idx" ON "credential_events" USING btree ("profile_id","generation_id","ledger_index","transaction_index","node_index");--> statement-breakpoint
CREATE INDEX "credential_events_exact_idx" ON "credential_events" USING btree ("profile_id","issuer","subject","schema_uid","ledger_index");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_generations_live_uq" ON "credential_generations" USING btree ("profile_id","issuer","subject","schema_uid") WHERE "credential_generations"."deleted_ledger_index" IS NULL;--> statement-breakpoint
CREATE INDEX "credential_generations_exact_idx" ON "credential_generations" USING btree ("profile_id","issuer","subject","schema_uid","created_ledger_index");--> statement-breakpoint
CREATE INDEX "credential_generations_stats_idx" ON "credential_generations" USING btree ("profile_id","deleted_ledger_index","accepted","expiration");--> statement-breakpoint
CREATE INDEX "demo_pins_wallet_quota_idx" ON "demo_pins" USING btree ("wallet","created_at");--> statement-breakpoint
CREATE INDEX "demo_pins_ip_quota_idx" ON "demo_pins" USING btree ("requester_ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "demo_pins_expiry_idx" ON "demo_pins" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "demo_pins_cid_active_idx" ON "demo_pins" USING btree ("cid","status","expires_at");--> statement-breakpoint
CREATE INDEX "pin_challenges_wallet_created_idx" ON "pin_challenges" USING btree ("profile_id","wallet","created_at");--> statement-breakpoint
CREATE INDEX "pin_challenges_ip_created_idx" ON "pin_challenges" USING btree ("requester_ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "pin_challenges_expiry_idx" ON "pin_challenges" USING btree ("expires_at");