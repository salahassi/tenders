-- Preserve confidentiality obligations in approved evidence and generated text.
-- Classification labels, credentials and personal contacts remain restricted.
create or replace function app_private.assert_business_content(value text)
returns void language plpgsql immutable set search_path='' as $$
begin
 if coalesce(value,'') ~* '(\mconfidential\M|سرية)[[:space:]]*[:：—–-]|(^|[\r\n]|\\[nr]|["=:])[[:space:]]*(confidential|سرية)[[:space:]]*($|[\r\n"]|\\[nr])|strictly private|سري للغاية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY|\m(sk|sb_secret)_[a-z0-9]{12,}|\+[0-9][0-9 ()-]{7,}[0-9]|\m[0-9]{3}[- .][0-9]{3}[- .][0-9]{4}\M'
 then raise exception 'DATA_POLICY_BLOCKED';end if;
end $$;
revoke all on function app_private.assert_business_content(text) from public,anon,authenticated;
