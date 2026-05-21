CREATE TABLE "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"is_group" boolean DEFAULT false NOT NULL,
	"participants_json" jsonb,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"sender" text NOT NULL,
	"sender_name" text,
	"timestamp" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"text" text,
	"media_url" text,
	"raw_json" jsonb NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_embedding_hnsw" ON "messages" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "messages_chat_ts_idx" ON "messages" USING btree ("chat_id","timestamp");--> statement-breakpoint
CREATE INDEX "messages_ts_idx" ON "messages" USING btree ("timestamp");