import {
  integer,
  sqliteTable,
  text,
} from "https://esm.sh/drizzle-orm@0.44.5/sqlite-core";

// Iron session storage table (used by OAuth package)
export const ironSessionStorage = sqliteTable("iron_session_storage", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
