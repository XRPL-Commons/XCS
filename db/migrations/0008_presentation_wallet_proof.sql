CREATE TABLE "app_presentation_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_presentation_challenges_presentation_id_unique" UNIQUE("presentation_id"),
	CONSTRAINT "app_presentation_challenges_request" CHECK (jsonb_typeof("app_presentation_challenges"."request") = 'object'),
	CONSTRAINT "app_presentation_challenges_message" CHECK (octet_length("app_presentation_challenges"."message") BETWEEN 1 AND 8192),
	CONSTRAINT "app_presentation_challenges_dates" CHECK ("app_presentation_challenges"."expires_at" > "app_presentation_challenges"."created_at" AND "app_presentation_challenges"."expires_at" <= "app_presentation_challenges"."created_at" + interval '5 minutes' AND isfinite("app_presentation_challenges"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "app_presentation_proofs" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"request" jsonb NOT NULL,
	"message" text NOT NULL,
	"signature" text NOT NULL,
	"public_key" text NOT NULL,
	"scheme" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_presentation_proofs_request" CHECK (jsonb_typeof("app_presentation_proofs"."request") = 'object'),
	CONSTRAINT "app_presentation_proofs_message" CHECK (octet_length("app_presentation_proofs"."message") BETWEEN 1 AND 8192),
	CONSTRAINT "app_presentation_proofs_signature" CHECK ("app_presentation_proofs"."signature" ~ '^[0-9A-Fa-f]{128,144}$'),
	CONSTRAINT "app_presentation_proofs_key" CHECK ("app_presentation_proofs"."public_key" ~ '^(02|03|ED|ed)[0-9A-Fa-f]{64}$'),
	CONSTRAINT "app_presentation_proofs_scheme" CHECK ("app_presentation_proofs"."scheme" IN ('ripple', 'otsu'))
);
--> statement-breakpoint
ALTER TABLE "app_presentation_challenges" ADD CONSTRAINT "app_presentation_challenges_session_id_app_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_presentation_proofs" ADD CONSTRAINT "app_presentation_proofs_presentation_id_app_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."app_presentations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_presentation_challenges_session_idx" ON "app_presentation_challenges" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "app_presentation_challenges_expiry_idx" ON "app_presentation_challenges" USING btree ("expires_at");