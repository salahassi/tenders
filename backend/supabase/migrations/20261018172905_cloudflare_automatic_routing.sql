-- Include Cloudflare in automatic routing without rewriting unrelated model policy.
-- Body hashes guard the source version before each edit and verify exact equality
-- with the fully tested function definitions afterwards. All changes are atomic.
do $migration$
declare r record; definition text; current_body text;
begin
-- Cloudflare participates in the same automatic routing as every other provider.
-- Preserve the owner's strategy, cursor and relative order; append the added slot.
alter table public.model_routing drop constraint model_routing_next_position_check;
alter table public.model_routing add constraint model_routing_next_position_check check(next_position between 0 and 7);
alter table public.model_routing drop constraint model_routing_provider_order_check;
alter table public.model_routing alter column provider_order set default array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[];
update public.model_routing set provider_order=array_append(provider_order,'cloudflare_free'),revision=revision+1,updated_at=now();
alter table public.model_routing add constraint model_routing_provider_order_check check(array_length(provider_order,1)=8 and provider_order @> array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and provider_order <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and array_position(provider_order,null) is null);
alter table public.model_routing drop constraint model_routing_free_providers_check;
alter table public.model_routing add constraint model_routing_free_providers_check check(free_providers <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and array_position(free_providers,null) is null);

for r in select * from (values
('public.prepare_model_routing_before_activity(uuid,uuid,jsonb)', '82a53a956e81bf6815bea32868a9a69d1fa034568b3def632a6b0e8605357eee', '91df62687a78e1d6895e27cbc24aebef97f132771128d587fe70f4fe278e3202'),
('public.record_model_attempt(uuid,uuid,text,text,boolean)', '29195d1d54a1c5a19528ce1c1e6a4421bcb42af46bc37e9013cc87f35d01ac0d', 'a9b98aa8f04a3292512909a6c753e57e59acc639bb200beb4abbec1ba008c450'),
('app_private.model_policy_command(text,jsonb,text)', '6d56a34e3ab1613c4555bfa27f39e3e9d7b2cca23cb424871238cc41080be01d', 'ccb80d74ae775b356ddb3b87d1b66710422944b991934985e1bae42c436ba1f0')
) as expected(signature, before_hash, after_hash) loop
 select prosrc,pg_get_functiondef(oid) into current_body,definition from pg_proc where oid=r.signature::regprocedure;
 if encode(sha256(convert_to(current_body,'UTF8')),'hex')<>r.before_hash then
  raise exception 'Unexpected function version: %',r.signature;
 end if;
 definition:=replace(definition,$old$'gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic'$old$,$new$'gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free'$new$);
 if r.signature='public.prepare_model_routing_before_activity(uuid,uuid,jsonb)' then
  definition:=replace(definition,'not in (4,5,7)','not in (4,5,7,8)');
  definition:=replace(definition,'saved seven-provider order','saved eight-provider order');
 elsif r.signature='public.record_model_attempt(uuid,uuid,text,text,boolean)' then
  definition:=replace(definition,'>=15','>=17');
 else
  definition:=replace(definition,$old$jsonb_array_length(input->'free_providers')>7$old$,$new$jsonb_array_length(input->'free_providers')>8$new$);
  definition:=replace(definition,$old$jsonb_array_length(input->'provider_order')<>7$old$,$new$jsonb_array_length(input->'provider_order')<>8$new$);
  definition:=replace(definition,$old$  if input ? 'provider_order' and$old$,$new$  -- Accept the previous seven-provider client during rolling publication.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=7 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["cloudflare_free"]'::jsonb);end if;
  if input ? 'provider_order' and$new$);
 end if;
 execute definition;
 select prosrc into current_body from pg_proc where oid=r.signature::regprocedure;
 if encode(sha256(convert_to(current_body,'UTF8')),'hex')<>r.after_hash then
  raise exception 'Unexpected function result: %',r.signature;
 end if;
end loop;
revoke all on function public.prepare_model_routing_before_activity(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
end $migration$;
