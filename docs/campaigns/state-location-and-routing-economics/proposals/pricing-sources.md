# Where a price comes from

Researched 2026-09-18 by a read-only worker, on the owner's instruction to find
out whether an API serves harness, vendor, model and price rather than have the
owner dictate a table that goes stale.

## The answer

`https://models.dev/api.json` is the best source and it is not a truth.

It is MIT, needs no key, answers a conditional GET with 304, and its
`cost.input`, `cost.cache_read` and `cost.output` are already USD per million
tokens — one-to-one with this product's own `pricing` object, no unit
conversion. It covers all five vendors first-party and 13 of the 14 model ids
this campaign has used.

No vendor publishes its own prices through an API except Google, whose catalogue
is real, keyed on English free text across 646 SKUs, and covers one vendor of
five.

So: **vendor the file as a dated seed, and diff it. Never fetch at report time.**
A historical run whose cost changes between two readings of the same run is
worse than one that says `unknown`.

## Why trust is conditional

Three findings, each verified against the vendor's own page.

**Two of nine adjudicated prices are wrong in `models.dev` today, both by 2×.**
`glm-5.3-flash` is wrong because a promotional price expired on 2026-09-09 and
the data did not follow. The source TOML carries a comment stating the real list
price — and `api.json` strips comments, so a consumer of the JSON cannot see that
the file contradicts its own documentation.

**OpenRouter carries a plain error** on `gpt-5.6-sol`: exactly half OpenAI's list
on every axis, byte-identical to its own `claude-sonnet-5` row. That would
understate 31 invocations by 2×. LiteLLM ingests OpenRouter on a schedule, so the
pipe for that error to travel exists.

**`deepseek-flash` is not statically priceable by anyone.** DeepSeek halves
off-peak against peak on a Beijing clock, prices in CNY, and publishes the table
only on its Chinese page. `models.dev` records off-peak; LiteLLM records peak.
Each is right half the day and 2× wrong the other half, and neither carries the
time axis. That is 25 of 163 invocations in this campaign.

## Two limits no price table fixes

Both are in this product, and both bound the achievable answer.

`canonicalUsage` folds `cache_creation_input_tokens` into `inputTokens`, so cache
writes are billed at the input rate — while Anthropic charges 1.25× input for a
5-minute write and OpenAI charges more than input. A perfect table still
undercounts.

`validatePricing` accepts three rates only, so adding a cache-write rate is a
contract change rather than a table change.

## What the worker could not verify

It did not call Anthropic's, OpenAI's or Google's pricing endpoints with
credentials; the "no price field" conclusion for Anthropic and Google rests on
their published schemas rather than a live body. It did not re-derive the Google
Cloud Billing result itself. DeepSeek's USD figures are its own arithmetic from
the CNY page at ~7 CNY/USD. It did not determine whether DeepSeek's peak window
is decided at request start or at billing time — which is not academic for
invocations that run tens of minutes. And every cadence claim is a snapshot of
one day's commit logs, not an observed history.

## Live query, investigated and closed

The owner's own idea, investigated live on 2026-09-18: instead of a static
price table, query the provider's own balance or spend around one invocation,
so a time-varying tariff (DeepSeek's peak/off-peak) adapts on its own. Closed,
no for all three vendors that motivated it, for two different reasons.

**DeepSeek.** The only live-spend surface is `GET
https://api.deepseek.com/user/balance`, one account-wide scalar rounded to
two decimal places — confirmed by polling every 3s for 30s around a real
completion with no movement. It carries no request id and no timestamp, so
under this tool's own concurrency (several harness invocations firing at
once, the normal case) a before/after snapshot around one invocation also
contains whatever subset of the other invocations settled in that window,
with no way to attribute which. That is closed, not merely hard: the only fix
is serializing every call through that account, which defeats the
concurrency the scheduler exists for. `platform.deepseek.com/usage` is
session-auth only (403 on an API key); no `/v1/usage`, `/dashboard/*`,
`/api/usage` or `/api/billing` path exists anywhere in DeepSeek's docs or API
surface, checked live.

**Zhipu / GLM.** No surface exists at all. Every usage and billing path on
both `open.bigmodel.cn` and `api.z.ai` returned 404 with a key that returns
200 on `/models` — confirmed as genuine absence, not an auth failure.

**Google / Gemini (`agy`).** Gemini-API-key traffic does route through Cloud
Billing once the underlying project links a billing account
(`ai.google.dev/gemini-api/docs/billing`). But the Cloud Billing Budget API
exposes only the configured cap and alert thresholds, no current-spend field;
itemized spend exists only via a BigQuery export the billing account owner
must pre-configure, which a `faberun` install will not have by default. Even
a configured export lands at daily-bucket granularity and inherits the same
concurrency-attribution problem one layer removed.

**Net effect.** Vendor `models.dev`'s `api.json` as a dated seed, diffed
against vendor pages before trusting a number — the original recommendation,
now load-bearing rather than a first guess. If DeepSeek's peak/off-peak
tariff is worth modelling precisely, the only workable path is hand-encoding
its published schedule in the static table, which is the thing this idea was
trying to avoid and the only approach that actually works.

## Owner's decision, 2026-09-18

"vamos vendorizar models.dev, nao precisa ser exato mas sempre precisamos
calcular o custo baseado nesses precos do models.dev e na quantidade de
tokens." Vendor the seed, do not chase exactness, but every invocation with a
known model must get a computed cost from tokens × the vendored rate rather
than reading `unknown`.
