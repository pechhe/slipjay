import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { nonAdditiveSql } from "../../src/lib/release/release.ts";

test("SQL is additive when earlier code cannot tell: new tables and columns, widened enums, loosened and generated columns", () => {
  for (const sql of [
    'CREATE TEMP TABLE "w" ON COMMIT DROP AS SELECT 1;\nDELETE FROM "w";\nUPDATE "w" SET "a" = 1;',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD COLUMN "b" boolean DEFAULT false NOT NULL;\nALTER TABLE "t" ADD CONSTRAINT "t_check" CHECK ("t"."a" is not null or not "t"."b");',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD CONSTRAINT "t_a_fk" FOREIGN KEY ("a") REFERENCES "u"("id");\nCREATE UNIQUE INDEX "t_a" ON "t" USING btree ("a");',
    'ALTER TABLE "t" ADD COLUMN "a" text;\nUPDATE "t" SET "a" = lower("b") WHERE "a" IS NULL;',
    'ALTER TABLE "t" DROP CONSTRAINT "t_kind_check";\nALTER TABLE "t" ADD CONSTRAINT "t_kind_check" CHECK ("t"."kind" in (\'a\', \'b\'));',
    'ALTER TABLE "t" ALTER COLUMN "a" DROP NOT NULL;',
    'ALTER TABLE "t" ADD COLUMN "d" tsvector GENERATED ALWAYS AS (to_tsvector(body)) STORED NOT NULL;',
    'ALTER TABLE "u" ADD COLUMN "x" text, ADD COLUMN "y" integer DEFAULT 0 NOT NULL;',
    'ALTER TABLE t ADD COLUMN a int;\nUPDATE t x SET a = (SELECT 1 FROM z WHERE z.id = x.id) WHERE true;',
    'ALTER TABLE s.t ADD COLUMN a int, ADD COLUMN b int, ADD UNIQUE (a, b);\nUPDATE s.t SET (a, b) = (1, 2);',
    'ALTER TABLE t ADD COLUMN "default" int NOT NULL DEFAULT 1;', "CREATE TABLE IF NOT EXISTS x (a int);",
    "select 1; -- DROP TABLE x\nCOMMENT ON TABLE t IS 'drop it; TRUNCATE t; -- not a comment';",
  ]) assert.equal(nonAdditiveSql(sql), false, sql);
  for (const sql of [
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD CONSTRAINT "t_check" CHECK ("t"."a" is not null or "t"."b" > 0);',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nCREATE UNIQUE INDEX "t_ab" ON "t" ("a", "b");',
    'ALTER TABLE "t" ADD COLUMN "a" text;\nUPDATE "t" SET "a" = 1, "b" = NULL;',
    'UPDATE "t" SET "a" = 1 WHERE "b" IS NULL;',
    'ALTER TABLE "t" DROP CONSTRAINT "t_kind_check";\nALTER TABLE "t" ADD CONSTRAINT "t_kind_check" CHECK ("t"."a" > 0);',
    'ALTER TABLE "t" ALTER COLUMN "a" DROP DEFAULT;', 'ALTER TABLE "t" DROP CONSTRAINT "t_pk";',
    'ALTER TABLE "t" ADD COLUMN "x" text, ADD COLUMN "y" integer NOT NULL;',
    // A widened CHECK is only that for the same table and constraint, as a plain IN list.
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE u ADD CONSTRAINT k CHECK (a IN ('x'));", "ALTER TABLE t ADD CONSTRAINT k CHECK (a IN ('x'));",
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE t ADD CONSTRAINT k CHECK (a NOT IN ('x'));",
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE t ADD CONSTRAINT k CHECK (a IN ('x') AND b > 1);",
    // Every UPDATE, assignment and clause counts, and tables are told apart by schema.
    "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = 1; UPDATE t SET d = 2;", "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = (SELECT a FROM z), d = 2;",
    "ALTER TABLE s.t ADD COLUMN c int; UPDATE t SET c = 1;", "ALTER TABLE t ADD COLUMN c int, ADD UNIQUE (a), ADD PRIMARY KEY (c);",
    "ALTER TABLE t ADD COLUMN c int; CREATE UNIQUE INDEX i ON t (c) WHERE a > 1;", "ALTER TABLE t ADD COLUMN c int; CREATE UNIQUE INDEX i ON t (c) INCLUDE (a);",
    "CREATE TABLE IF NOT EXISTS t (a int); ALTER TABLE t ADD COLUMN b int NOT NULL;",
    "ALTER TABLE t ADD UNIQUE (a);", "ALTER TABLE t ADD CHECK (a > 1);", "ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u(id);",
    "ALTER TABLE t ALTER a TYPE text;", "ALTER TABLE t ALTER a SET NOT NULL;", "ALTER TABLE t VALIDATE CONSTRAINT k;",
    "ALTER TABLE t ENABLE ROW LEVEL SECURITY;", "CREATE POLICY p ON t USING (true);", "CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
    "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;", "MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE;",
    "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2;", "DO $$ BEGIN ALTER TABLE t DROP COLUMN a; END $$;",
  ]) assert.equal(nonAdditiveSql(sql), true, sql);
});

test("SQL is non-additive when it removes, retypes or deletes, or tightens a table that already existed", () => {
  for (const sql of [
    'ALTER TABLE "t" DROP COLUMN "a";', "alter table t rename to u;", "DELETE FROM t WHERE a IS NULL;", "TRUNCATE t;",
    'ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE text;', 'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;',
    "ALTER TABLE t ADD CONSTRAINT positive CHECK (a > 0);", 'CREATE UNIQUE INDEX "t_a" ON "public"."t" USING btree ("a");',
    'ALTER TABLE "t" ADD COLUMN "b" integer NOT NULL;',
  ]) assert.equal(nonAdditiveSql(sql), true, sql);
  for (const sql of [
    'CREATE TABLE "u" ("id" text PRIMARY KEY NOT NULL, "t_id" text);\n--> statement-breakpoint\nALTER TABLE "u" ADD CONSTRAINT "u_t_fk" FOREIGN KEY ("t_id") REFERENCES "public"."t"("id");\nCREATE UNIQUE INDEX "u_t" ON "u" ("t_id");',
    'ALTER TABLE "t" ADD COLUMN "b" integer DEFAULT 0 NOT NULL;', 'ALTER TABLE "t" ADD COLUMN "c" text;', "CREATE INDEX t_a ON t (a);",
    "/* DROP TABLE t; */ select 1; -- truncate t",
  ]) assert.equal(nonAdditiveSql(sql), false, sql);
});
