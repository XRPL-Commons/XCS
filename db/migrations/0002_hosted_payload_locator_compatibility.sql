ALTER TABLE "hosted_payloads" DROP CONSTRAINT "hosted_payloads_digest_hex_unique";--> statement-breakpoint
ALTER TABLE "hosted_payloads" DROP CONSTRAINT "hosted_payloads_locator";--> statement-breakpoint
ALTER TABLE "hosted_payloads" ADD CONSTRAINT "hosted_payloads_locator" CHECK ("hosted_payloads"."locator" ~ '^(?:[0-9a-f]{18}|[0-9a-f]{20})$');