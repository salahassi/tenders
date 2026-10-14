import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

export async function databaseWithMigrations() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;
  `);
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const versions = names.map((name) => name.split("_")[0]);
  if (new Set(versions).size !== versions.length) {
    await db.close();
    throw new Error("Migration versions must be unique.");
  }
  for (const name of names)
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  return db;
}
