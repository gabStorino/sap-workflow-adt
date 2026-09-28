# sap-workflow-adt 0.2.0

- New `wf_bo_approval_scaffold` (`BoApprovalHandlers` + `src/lib/boApprovalTemplates.ts`): approve/reject workflow on a Z subtype of any BOR object. Pre-flight (BO key from SWOTDV/DD03L, change document object from SWECDOBJ/TCDOB, prefix number T78NR, SWU3 destination `WORKFLOW_LOCAL_<client>`, existing objects), generated Z log table, update FM (MODIFY, no COMMIT, exceptions), optional `SAP_WAPI_CREATE_EVENT` FM (`commit_work = space`), BOR method code and an ordered SAP GUI guide (SWO1 → SWEC → SWDD → SWUE/SWI1). Recipe validated end to end with `BUS2012`/`ZCUST_PO` on S/4HANA; generated ABAP for a composite-key BO (`BUS2081`) activated cleanly.
- Fix: `abap_activate` with `type=FUGR/FF` activates the function group and the FM together.
- Tests: +19 unit tests (`boApproval.test.ts`).
- Fix: `DCLS`/`DCLS/DL` now map to `/sap/bc/adt/acm/dcl/sources` (was `/sap/bc/adt/dcls`, which returned "does not exist"), so `abap_get_source`, `abap_set_source` and `abap_activate` work for access controls.

# sap-workflow-adt 0.1.0

- New `WorkflowHandlers`: `package_create`, `msag_set_messages`, `wf_class_scaffold`.
- New `src/lib/wfTemplates.ts` (pure generators, unit tested; generated sources verified on S/4HANA: 5/5 ABAP Unit tests green).
- `abap_run` and `runClassrun`: fresh sessions via `freshSession()`, `withSession` around create/lock-write-unlock/activate, unique default class name, `postClassrun()` with backoff retries.
- Tests: +34 unit tests (wfTemplates, workflowHandlers, classrunRetry).

# What Changed

Based on the original MCP server by Mario Andreschak. This fork focuses on letting the AI do real development work — not just read code, but write it, activate it, manage transports, and clean up after itself. The changes below address what broke when we started using it that way.

## Crash elimination

Every handler in the original would blow up with `Cannot read properties of undefined` if the AI forgot a parameter. We added a centralized validation middleware in BaseHandler that reads each tool's JSON schema `required` array and rejects calls with missing fields *before* any handler logic runs. One guard for all 25 tools. 163 unit tests verify it.

## Type auto-mapping

The ADT library needs `CLAS/OC`, `PROG/P`, `DDLS/DF`, etc. AIs send `CLAS`, `PROG`, `DDLS`. The server now maps 16 short types to their full subtypes automatically in `abap_create`. No more "Unsupported object type" errors.

## FUGR handling

The original `transport_assign` did lock→write→unlock on function groups, which writes to the main include and creates an inactive SAPL program version. We added FUGR, MSAG, and ENHS to a `METADATA_TYPES` set that uses `transportReference` instead — no lock, no write, no inactive version.

## Delete bypass

The `abap-adt-api` library appends `?corrNr=TRANSPORT` to DELETE requests. SAP's DDLS endpoint rejects that parameter. We bypass the library and call `h.request(objectUrl, { method: 'DELETE', qs: { lockHandle } })` directly.

## ATC workaround

On systems with `ciCheckFlavour=true` (like D25), `createAtcRun` ignores the variant and runs CI-scoped checks. We skip `createAtcRun` entirely and fetch the existing worklist via `atcCheckVariant` → `atcWorklists` — same results as a full Eclipse ATC run.

## Interface method auto-detection

`IF_OO_ADT_CLASSRUN` uses `~run` on ≤2023 and `~main` on 2024+. The original hardcoded `run`. We read the interface source after login to detect the correct method. The `abap_run` tool now works on D23, D25, and M25 without the user knowing which release they're on.

## Session management

`withSession()` wraps every ADT call. If the session expires mid-operation, it re-logs in automatically and retries. Users never see a session timeout error.

## Error intelligence

`parseAdtError` classifies every SAP error: session timeout, upgrade mode (SPAU), locked objects, not found, opaque `I::000` codes, L-prefix include rejection. `formatError` adds actionable hints — "Check SM12 for locks", "Run SPAU_ENH to clear upgrade flag", "Use FUGR/FF instead of the system-generated include name." `formatActivationMessages` adds hints for syntax errors, inactive dependents, locked objects, and pipe character escaping in string templates. The AI reads these hints and self-corrects on the next call.

## Smart redirects

If the AI passes a transport number to `transport_info` (which expects an object name), the server detects the pattern via regex and responds: "Use `transport_contents` instead." This happens for every common mistake we've seen AIs make.

## MCP elicitation

When a required parameter is missing, instead of returning an error, the server sends an `elicitation/create` request back to the client. The user sees a form: "Which package should this object be created in?" with a default of `$TMP`. They pick, the server continues. No round-trip through the AI.

Wired up on:
- `abap_create` — missing package prompt
- `abap_set_source` — missing transport prompt (catches SAP rejection, asks user, retries)
- `abap_delete` — non-$TMP confirmation with object/transport context
- `abap_activate` — inactive dependents offer to activate them
- `abap_run` — leftover class from failed run, offers to delete and retry
- `transport_assign` — confirmation before modifying transport contents
- `transport_release` — irreversible action confirmation

Falls back gracefully on clients that don't support elicitation.

## abap_run rewrite

The original called the library's `runClass()` which sent no Accept header, causing silent failures. We call the classrun endpoint directly with `Accept: text/plain`. We also handle: session state transitions (stateful for activation → stateless for classrun), HTTP 200 with error body detection, 500 with ST22 dump hint, and automatic cleanup with best-effort delete in a `finally` block.

## abap_get_function_group

New tool. Fetches `/objectstructure`, parses all `atom:link` hrefs for includes and function modules, fetches all sources in parallel. One call gives you the entire function group instead of 15 individual `abap_get_source` calls.

## abap_query and abap_table fixes

The library's `runQuery()` omits `Content-Type`, causing 400 on all systems. We set `Content-Type: text/plain` and `Accept: application/*` via direct HTTP. `abap_table` detects LIKE/BETWEEN in WHERE clauses and routes through `datapreview/freestyle` instead of `tableContents` which rejects them.

## Test suite

163 unit tests covering URL builder (every object type, namespace encoding, edge cases), error classification (every SAP error condition), and input validation (every tool with missing required params). Integration test scaffold for live SAP testing. E2E write-path test: create → write → syntax check → activate → delete. AI self-test prompt for exploratory fuzzing. All running on Jest with ts-jest, `npm test` in under 3 seconds.

## What didn't change

The `abap-adt-api` library by Marcello Urbani. The MCP SDK. The basic handler architecture (BaseHandler → subclass per domain). We built on what worked and fixed what broke in real use.

## Credits

- **Mario Andreschak** — original MCP server scaffold
- **Marcello Urbani** — `abap-adt-api` library (the ADT HTTP client underneath everything)
- **Dassian Inc.** — validation, elicitation, error handling, test suite

## rap_bo_scaffold (v0.3.0)

New tool: full managed RAP Business Object scaffold from an existing DDIC table. Generates, in dependency order:
CDS interface (root) view entity (field names read from DD03L, beautified to UpperCamelCase) → empty managed
behavior pool class → optional draft table → root behavior definition (managed, optional `draft table`/`draft action`
clauses) → CDS projection (consumption) view entity → projection behavior definition (`projection;` delegating with
`use`) → service definition. `mode=check`/`preview`/`deploy` mirrors `wf_bo_approval_scaffold`'s modes.

The service binding (SRVB) is deliberately **not** auto-created in `mode=deploy` — the underlying `abap-adt-api`
`createObject()` binding options only cover OData V2, and hand-rolling the OData V4 binding XML without having
verified it against a real system risks a half-created object needing manual SE80/ADT cleanup (the same class of
risk the `raw_http` hard rule already protects against elsewhere in this codebase). Instead the tool returns an
ordered guide step: create the binding manually (ADT/Eclipse "New Service Binding" or SAP GUI), then use the
already-verified `rap_publish_binding` to publish it. This complements `rap_binding_details`/`rap_publish_binding`
(`RapHandlers.ts`), which operate on an already-existing binding — this tool builds everything that comes before it.

The generated draft table (when `draft=true`) is a best-effort starting point (business keys + DRAFTUUID/
DRAFTISDRAFT/DRAFTLASTCHANGEDAT) and is flagged as not verified end to end — SAP's exact draft-admin-field shape has
changed across NW/S4 releases, so compare it against a system-generated draft table before deploying, same honesty
convention as `wf_bo_approval_scaffold`'s `verified=false` display presets.

New files: `src/lib/rapBoTemplates.ts` (pure, unit-tested generators), `src/handlers/RapBoScaffoldHandlers.ts`.
21 new unit tests in `src/__tests__/unit/rapBoScaffold.test.ts` (337 total, up from ~180).

## rap_bo_scaffold: activation order fix (found via live test on T001)

`mode="deploy"` was activating the behavior pool class before the root behavior definition. SAP rejects that
order: activating a class `FOR BEHAVIOR OF <view>` requires a behavior definition to already exist and be active
for that view, or activation fails with `"[E] There is no behavior definition for \"<view>\"."` — confirmed by a
real deploy against Gabi's S/4HANA training system (T001, package $TMP). Fixed order is now: interface view →
[draft table] → root behavior definition → behavior pool class → projection view → projection behavior
definition → service definition. No user action needed on a retry — the create/write steps already skip objects
TADIR shows as existing, so a partially-created class from a failed prior attempt is just re-written and
re-activated in the corrected order.

## rap_bo_scaffold: strict(2) -> strict(1) (found via live test on T001)

The generated behavior definitions used `strict(2);`. Activating the root BDEF on Gabi's S/4HANA training system
failed with `"[E] Unexpected character \"2\"."` — that release doesn't recognize the `strict(2)` level. Switched
the default to `strict(1);`, the original and most broadly supported strict-mode level. If your release supports
`strict(2)` (stricter type/annotation checks) and you want it, edit the generated BDEF source before deploying —
this is a template default, not a hard limit.

## rap_bo_scaffold: idempotent BDEF creation (found via live retry on T001)

`mode="deploy"` always called `abap_create` for both behavior definitions, never checking whether they already
existed — so retrying a deploy that got partway through (e.g. after the strict(1) fix above) failed with
"Resource Behavior Definition ZI_T001 does already exist." Pre-flight now checks TADIR filtered by object type
(BDEF vs DDLS — they share the same object name, so the object-type filter is what tells them apart) and skips
the create step for a BDEF that's already there, same as it already did for the DDLS/CLAS/SRVD/TABL steps. A
retry after any partial failure now just resumes.

## rap_bo_scaffold: strict(N) -> plain strict; (found via live test on T001)

Same "Unexpected character" activation error recurred with `strict(1);` after fixing the `strict(2);` one — the
digit changed, the failure didn't, which meant the parenthesized `strict(N)` form itself isn't recognized by this
release's behavior-definition parser, not the version number inside it. Switched to the older, unparenthesized
`strict;` declaration, which every RAP-capable release accepts. If your release does support `strict(N)` and you
want its extra checks, add the parentheses back in the generated BDEF source before deploying.

## rap_bo_scaffold: dropped the "strict" declaration entirely (found via live test on T001)

Third variant in a row failed: `strict(2);` -> "Unexpected character 2", `strict(1);` -> "Unexpected character 1",
plain `strict;` -> `"with" expected, not "strict"`. The grammar around this declaration clearly varies enough
across releases that guessing another spelling wasn't worth the risk of another broken deploy attempt on a real
system. It's optional (extra compile-time checks, not required for a working managed BO), so it's no longer
generated at all. The guide now tells the user to add it back manually in ADT if their release supports it and
they want the stricter checks.

## rap_bo_scaffold: dropped "provider contract transactional_query" (found via live test on T001)

After the strict fixes above, DDLS ZI_T001, its BDEF, and ZBP_T001 all activated successfully — real progress.
The projection view then failed activating with `"[E] Unexpected word \"provider\"\n[E] DDLS ZC_T001 was not
activated"`. Same story as strict: this release's DDL compiler doesn't recognize the "provider contract
transactional_query" clause used for RAP consumption views on current releases. Removed it; the projection view
now generates as a plain "as projection on" without a provider contract. Guide step 6 tells the user to add the
appropriate provider contract back themselves if their release supports it — it's standard practice on current
releases, just not on this training system.

## 2026-09-28 — rap_bo_scaffold: stop masking real query errors as "table not found"

- Fix: `safeRows()` in `RapBoScaffoldHandlers.ts` caught every exception from the DD03L/TADIR pre-flight queries and silently returned an empty array. A real connection/TLS/auth error looked identical to "table genuinely not found", which masked a live TLS failure during testing as a false `Table T001 not found` blocker.
- Replaced it with `queryRows()`, which returns rows plus an optional error message instead of swallowing the exception. `collectPreflight` now reports a distinct blocker ("Could not read <table> from DD03L -- this looks like a connection or query error, not a missing table") when the field query itself fails, and a distinct warning when the TADIR existence check fails, instead of silently treating either as "nothing found".
- Tests: all 21 existing rapBoScaffold.test.ts unit tests still pass unmodified (no test asserted on the swallowed-error behavior).

## 2026-09-28 — rap_bo_scaffold: add missing currency/quantity semantic annotations (found via live Fiori Elements test on SFLIGHT)

- Bug: `CX_SADL_DUMP_APPL_MODEL_ERROR` short dump the moment a Fiori Elements app actually queried a generated BO (SFLIGHT/ZC_SFLIGHT), even though every DDLS/BDEF/CLAS activated cleanly. Root cause: SFLIGHT's PRICE and PAYMENTSUM are DD03L DATATYPE=CURR referencing CURRENCY (DATATYPE=CUKY) as REFFIELD, and the generated interface view exposed them with no `@Semantics.amount.currencyCode` annotation. CDS activation does not catch this -- it only surfaces at runtime once the OData/SADL layer tries to format an amount without knowing its currency.
- Fix: `RapBoScaffoldHandlers.collectPreflight` now also selects DD03L-DATATYPE and DD03L-REFFIELD. `buildInterfaceViewSource` (rapBoTemplates.ts) annotates CURR fields with `@Semantics.amount.currencyCode: '<RefFieldAlias>'` and QUAN fields with `@Semantics.quantity.unitOfMeasure: '<RefFieldAlias>'`, and marks the paired CUKY/UNIT field with `@Semantics.currencyCode: true` / `@Semantics.unitOfMeasure: true`. Skipped silently (no annotation, same as before) when the reference field isn't exposed in the generated view.
- Tests: +6 unit tests covering CURR/QUAN annotation, the reverse currencyCode/unitOfMeasure marker, the skip-when-ref-missing case, and backward compatibility for tables with no CURR/QUAN fields (all 27 rapBoScaffold tests pass).

### Follow-up (same day): dropped the reverse annotation

The first version of this fix also added `@Semantics.currencyCode: true` / `@Semantics.unitOfMeasure: true` on the CUKY/UNIT field itself, mirroring classic CDS view practice. Live deploy on the very next attempt failed activation: `"[E] Annotation Semantics.currencyCode is not allowed in view entities."` -- that annotation form is specific to `define view` (classic CDS) and is rejected on `define root view entity` (the RAP/View Entity syntax this tool generates). Removed it; only the CURR/QUAN field itself is annotated with `@Semantics.amount.currencyCode`/`@Semantics.quantity.unitOfMeasure` now. Tests updated to assert the reverse annotation is never emitted; all 26 rapBoScaffold tests pass.

## 2026-09-28 — rap_bo_scaffold: dropped 'authorization master ( instance )' (found via live Fiori Elements test on SFLIGHT)

- Bug: even with the currency annotations fixed, the Fiori Elements preview still dumped with `CX_SADL_DUMP_APPL_MODEL_ERROR`. ST22 error analysis showed the real cause in the exception chain: `CX_RAP_HANDLER_NOT_IMPLEMENTED` in `CL_RAP_BHV_PROCESSOR`, method `AUTHORITY_CHECK`, entity ZC_SFLIGHT. The root BDEF declared `authorization master ( instance )`, which requires a `get_instance_authorizations` handler, but the generated behavior pool is intentionally empty. Activation does not catch this; the first UI read does, because Fiori asks for update/delete availability per row.
- Fix: the root behavior definition no longer declares `authorization master`. New guide step 7 tells the user to add it back together with the handler when they implement real authorization checks (draft caveat renumbered to step 8).
- Applied live to ZI_SFLIGHT's BDEF (removed the clause, reactivated cleanly); the Fiori Elements preview for ZUI_SFLIGHT_O4 then loaded data without dumping.
- Tests: +2 (no authorization master in root BDEF, with and without draft; guide mentions it). 28/28 rapBoScaffold tests pass.
