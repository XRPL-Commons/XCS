CREATE TABLE "app_auth_transactions" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_auth_transactions_hashes" CHECK ("app_auth_transactions"."state_hash" ~ '^[0-9a-f]{64}$' AND "app_auth_transactions"."browser_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_auth_transactions_tokens" CHECK ("app_auth_transactions"."nonce" ~ '^[A-Za-z0-9_-]{43}$' AND "app_auth_transactions"."code_verifier" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "app_auth_transactions_return_to" CHECK (length("app_auth_transactions"."return_to") BETWEEN 1 AND 2048 AND left("app_auth_transactions"."return_to", 1) = '/' AND left("app_auth_transactions"."return_to", 2) <> '//' AND position(chr(92) in "app_auth_transactions"."return_to") = 0 AND "app_auth_transactions"."return_to" !~ '[[:cntrl:]]'),
	CONSTRAINT "app_auth_transactions_dates" CHECK ("app_auth_transactions"."expires_at" > "app_auth_transactions"."created_at" AND isfinite("app_auth_transactions"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "app_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "app_sessions_token" CHECK ("app_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_sessions_csrf" CHECK ("app_sessions"."csrf_token" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "app_sessions_dates" CHECK ("app_sessions"."expires_at" > "app_sessions"."created_at" AND "app_sessions"."absolute_expires_at" >= "app_sessions"."expires_at" AND isfinite("app_sessions"."absolute_expires_at"))
);
--> statement-breakpoint
CREATE TABLE "app_wallet_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"network_id" bigint NOT NULL,
	"address" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_wallet_challenges_network" CHECK ("app_wallet_challenges"."network_id" BETWEEN 0 AND 4294967295),
	CONSTRAINT "app_wallet_challenges_address" CHECK ("app_wallet_challenges"."address" ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
	CONSTRAINT "app_wallet_challenges_message" CHECK (length("app_wallet_challenges"."message") BETWEEN 1 AND 8192),
	CONSTRAINT "app_wallet_challenges_dates" CHECK ("app_wallet_challenges"."expires_at" > "app_wallet_challenges"."created_at" AND isfinite("app_wallet_challenges"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "app_user_roles" ALTER COLUMN "role" SET DEFAULT 'recipient';--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_wallet_challenges" ADD CONSTRAINT "app_wallet_challenges_session_id_app_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_auth_transactions_expiry_idx" ON "app_auth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_sessions_user_idx" ON "app_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_sessions_expiry_idx" ON "app_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_wallet_challenges_session_idx" ON "app_wallet_challenges" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "app_wallet_challenges_expiry_idx" ON "app_wallet_challenges" USING btree ("expires_at");