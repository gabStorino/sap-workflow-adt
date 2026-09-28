# sap-workflow-adt

Fork of [dassian-adt](https://github.com/DassianInc/dassian-adt) (MIT) focused on **SAP Business Workflow** development.
Everything from dassian-adt is kept; this fork adds:

| Tool | What it does |
|------|-------------|
| `package_create` | Creates a package through the ADT packages API (v2 XML): top-level (software component / transport layer) or sub-package. |
| `msag_set_messages` | Adds/replaces messages of a message class through the ADT API (lock → PUT → unlock), merge or replace mode. |
| `wf_class_scaffold` | Generates an IF_WORKFLOW class following *ABAP Development for SAP Business Workflow* (Werner), ch. 7: GUID key, private instantiation + factories, instance management via `FIND_BY_LPOR`, data cluster persistence, `CX_BO_ERROR`/`CX_BO_TEMPORARY` exceptions with T100 texts, workflow events and an ABAP Unit include. `mode=preview` returns the sources; `mode=deploy` creates, activates and tests everything. |
| `wf_bo_approval_scaffold` | Approve/reject workflow on a **Z subtype of any BOR object** (e.g. `BUS2012` → `ZCUST_PO`): the change document (SWEC) raises the Z event on save → dialog step displays the document → user decision → container operation `STATUS = A/R` → background step writes a Z log table. Reads the BO key (SWOTDV/DD03L, composite keys supported), suggests the change document object (SWECDOBJ/TCDOB) and checks the workflow prefix number (T78NR) and the SWU3 RFC destination for the GUI client. `mode=check` = pre-flight; `mode=preview` = sources + BOR method code + SAP GUI guide; `mode=deploy` also creates and activates the Z table, function group and FMs. SWO1, SWEC and PFTC/SWDD have no ADT API, so they come back as an ordered GUI guide. Display preset verified end to end only for `BUS2012`. |
| `rap_bo_scaffold` | Managed **RAP Business Object from an existing DDIC table**: CDS interface (root) and projection view entities, behavior definitions for both, an empty behavior pool class, a service definition and an optional draft table. Field names come from DD03L and are beautified to UpperCamelCase; CURR/QUAN fields get `@Semantics.amount.currencyCode` / `@Semantics.quantity.unitOfMeasure` from DD03L-REFFIELD. `mode=check` = pre-flight; `mode=preview` = sources + guide; `mode=deploy` creates and activates everything in RAP dependency order. The service binding is not created (manual step in ADT, then `rap_publish_binding`). Verified end to end with `SFLIGHT` up to the Fiori Elements preview. |

Fixes:

- **`abap_activate` with `type=FUGR/FF`**: activates the function group *and* the function module in one request. Activating only the group could report success while the FM stayed inactive.
- **`abap_run` / internal classrun**: every step now runs in `withSession` on a fresh session (a stateful/stateless mismatch caused bare HTTP 400s), the default temp class gets a unique name (a fixed name let an old class load run on another app server), and the classrun POST retries while a freshly activated class is not yet visible on the answering app server (`Error: Class does not implement ~main`). Wait limit: `CLASSRUN_WAIT_MS` (default 90000).
- **`rap_binding_details` with OData V4 bindings**: the underlying library only understood V2 bindings and failed with `Cannot destructure property 'query' of 'queries[index]'`. V4 bindings are now read directly and return the service URL (relative and full), the service version and the entity sets.

## Install (this fork)

```bash
git clone https://github.com/gabStorino/sap-workflow-adt.git
cd sap-workflow-adt
npm install          # use install, not ci, on Windows (optional macOS-only deps)
npm test
npm run build        # dist/
npm run bundle       # bundle/sap-workflow-adt.js, the file Claude Desktop runs
```

Step-by-step guide in Portuguese: [docs/INSTALACAO.md](docs/INSTALACAO.md).

## `wf_bo_approval_scaffold`

Builds the classic "custom BO + event + approve/reject + background update" workflow for **any BOR object**, as a Z subtype of the standard one.

```
document changed and saved
  └─ SWEC (change document) raises Z<BO>.<EVENT>
       └─ WS template started by the event
            ├─ dialog step: DISPLAYNEW (show the document) → workflow initiator
            ├─ user decision: Approve / Reject
            │    ├─ container operation STATUS = 'A'
            │    └─ container operation STATUS = 'R'
            ├─ (join) background step: UPDATETABLE → update FM → Z log table
            └─ end
```

### Parameters

| Parameter | Required | Meaning |
|---|---|---|
| `supertype` | yes | Standard BOR type, e.g. `BUS2012` |
| `subtype` | yes | Z subtype to create in SWO1, e.g. `ZCUST_PO` (max 10) |
| `event` | | Custom event (default `ZCHANGED`) |
| `mode` | | `check`, `preview` (default) or `deploy` |
| `client` | | Client where the workflow runs (SAP GUI). Enables the T78NR and SWU3 checks |
| `cdObject` | | Change document object for SWEC (default: suggested from SWECDOBJ/TCDOB) |
| `package` / `transport` | deploy | `$TMP` needs no transport |
| `includeRaiseFm` | | Also generate an FM that raises the event with `SAP_WAPI_CREATE_EVENT` (for a save exit/BAdI instead of SWEC) |
| `displayFm` / `displayTcode` + `displayParamIds` | | How to display the document when there is no preset |
| `table`, `functionGroup`, `updateFm`, `raiseFm`, `wfAbbrev`, `tsDisplayAbbrev`, `tsUpdateAbbrev` | | Name overrides (defaults derived from the subtype) |

### Modes

- **`check`**: pre-flight only.
  - Reads the BO key fields (SWOTDV + DD03L, composite keys supported).
  - Suggests the change document object.
  - Checks that the target client has a workflow prefix number (T78NR/OOW4) and the SWU3 RFC destination `WORKFLOW_LOCAL_<client>`.
  - Reports objects that already exist.
- **`preview`**: pre-flight plus every generated source.
  - Z log table (DDL), update FM (`MODIFY`, no `COMMIT WORK`, exceptions) and the optional raise-event FM.
  - BOR method code to paste in SWO1.
  - Ordered SAP GUI guide: SWO1 → SWEC → SWDD → SWUE/SWI1.
- **`deploy`**: `preview` plus, through ADT:
  - creates and activates the Z table, function group and FMs;
  - checks that nothing is left inactive.

The BOR subtype (SWO1), the SWEC entry, the tasks and the WS template (PFTC/SWDD) have no ADT API. They are returned as the GUI guide, to be done by hand or by an assistant driving SAP GUI.

### Example

```json
{ "supertype": "BUS2012", "subtype": "ZCUST_PO", "event": "POCHANGED", "client": "500", "mode": "check" }
```

Then `mode: "preview"` to review the code, and `mode: "deploy"` with `package: "$TMP"`.

### Display presets

| BO | Display | Status |
|---|---|---|
| `BUS2012` Purchase order | FM `ME_DISPLAY_PURCHASE_DOCUMENT` | verified end to end |
| `BUS2105` Purchase requisition | `ME53N` (param `BAN`) | not verified |
| `BUS2032` Sales order | `VA03` (param `AUN`) | not verified |
| `BUS1001006` Material | `MM03` (param `MAT`) | not verified |
| `BUS2081` Supplier invoice | `MIR4` (params `RBN`, `GJR`) | not verified; generated table/FMs for its composite key activate cleanly |

Any other BO gets a `TODO` in the display method unless you pass `displayFm` or `displayTcode`.

### Known blockers (what the pre-flight warns about)

- **No prefix number for the client (T78NR)**: no task or workflow can be saved. Create one in OOW4.
- **SWU3 not done (no `WORKFLOW_LOCAL_<client>`)**: the event finds its receiver in SWUE, but no workflow starts. Needs an administrator, because it sets the WF-BATCH password.
- **Delegation**: only one per supertype exists in the whole system. The workflow does not need it, so do not create it on a shared system.

Lessons encoded in the generated ABAP (see `src/lib/wfTemplates.ts`): no `*` comment lines between methods in source-based classes; `EXPORT/IMPORT ... ID` needs a variable; data cluster IDs are max 22 characters (GUID-22); never write T100/T100U directly (ADT then returns HTTP 500 for the message class).

## `rap_bo_scaffold`

Builds a complete **managed RAP Business Object** (no custom logic) on top of an existing DDIC table.

```
DDIC table (e.g. SFLIGHT)
  └─ ZI_<name>   CDS interface view entity (root)      + behavior definition (managed, persistent table, mapping)
       └─ ZBP_<name>  behavior pool class (empty: the framework does create/update/delete)
       └─ ZC_<name>   CDS projection view entity (UI)  + projection behavior definition (use create/update/delete)
            └─ ZSD_<name>  service definition
                 └─ ZUI_<name>_O4  service binding  ← manual step in ADT, then rap_publish_binding
```

### Parameters

| Parameter | Required | Meaning |
|---|---|---|
| `table` | yes | Source DDIC table, e.g. `ZCUSTORDER` or `SFLIGHT` |
| `mode` | | `check`, `preview` (default) or `deploy` |
| `name` | | Base name for the artifacts (default: table name without its Z/Y prefix) |
| `description` | | Short text on every generated object (default `RAP BO for <table>`) |
| `draft` | | Add draft handling (draft table + draft actions). Default `false`; see caveats |
| `serviceVersion` | | `V4` (default) or `V2`. Only affects the binding name and the guide |
| `package` / `transport` | deploy | `$TMP` needs no transport |
| `interfaceView`, `projectionView`, `behaviorPoolClass`, `serviceDefinition`, `serviceBinding`, `draftTable` | | Name overrides (defaults `ZI_`, `ZC_`, `ZBP_`, `ZSD_`, `ZUI_..._O4`, `<table>D`) |

### Modes

- **`check`**: pre-flight only.
  - Reads the table fields from DD03L (keys, data element, `DATATYPE`, `REFFIELD`); `MANDT` is dropped.
  - Blocks if the table has no key besides `MANDT`.
  - Reports which objects already exist (DDLS and BDEF are checked separately in TADIR, since they share the name).
  - A failed DD03L query (connection, TLS, authorization) is reported as a query error, not as "table not found".
- **`preview`**: pre-flight plus every generated source and the guide of manual steps.
- **`deploy`**: `preview` plus, through ADT, creates, writes and activates in this order: interface view → [draft table] → root behavior definition → behavior pool class → projection view → projection behavior definition → service definition. The root BDEF must be active before the class, or SAP rejects the class with "no behavior definition for <view>". Re-running `deploy` overwrites the sources of objects that already exist.

### Example

```json
{ "table": "SFLIGHT", "mode": "check" }
```

Then `mode: "preview"` to review the sources, and `mode: "deploy"` with `package: "$TMP"`. After the deploy:

1. In ADT, right-click `ZSD_<name>` → **New Service Binding**, name `ZUI_<name>_O4`, type **OData V4 - UI**, and activate it.
2. `rap_publish_binding` with `name: "ZUI_<name>_O4"`, `version: "0001"`, `action: "publish"`.
3. `rap_binding_details` with `name: "ZUI_<name>_O4"` returns the service URL and entity sets.
4. Preview the Fiori Elements app from the binding in ADT.

### What is deliberately not generated

Each item below failed on a real system and was removed. Add it back by hand when your release or scenario needs it.

- **`strict` / `strict(N)`** in the behavior definitions: rejected by the test system's BDEF parser in every form tried.
- **`provider contract transactional_query`** in the projection view: rejected with `Unexpected word "provider"`.
- **`authorization master ( instance )`**: it requires a `get_instance_authorizations` handler, and the behavior pool is generated empty. Activation does not catch this; the first read from Fiori dumps with `CX_SADL_DUMP_APPL_MODEL_ERROR` (`CX_RAP_HANDLER_NOT_IMPLEMENTED`, method `AUTHORITY_CHECK`). Add the clause together with the handler when you implement authorization.
- **`@Semantics.currencyCode: true`** on the currency field itself: classic CDS view syntax, rejected on view entities. Only the amount/quantity field is annotated.

### Caveats

- **The BO writes to the source table.** Create, update and delete from the app go straight to that table. On a standard table (e.g. `SFLIGHT`) remove `create; update; delete;` from both behavior definitions if you only want to read.
- **No authorization checks and no DCL.** The interface view has `@AccessControl.authorizationCheck: #CHECK` but no access control is generated.
- **Minimal UI.** Only `@UI.lineItem` / `@UI.identification` per field; no selection fields, facets or value helps.
- **Draft (`draft: true`) is not verified end to end.** The draft table is a best-effort starting point; check its technical fields against your release.

---

## Original dassian-adt README

MCP server for SAP ABAP development via the ADT API. Connect AI assistants to your SAP system — read, write, test, and deploy ABAP code without SAP GUI.

The AI can create objects, write source, activate, manage transports, run code, query tables, and check quality. Full development lifecycle, not just read-only or code generation.

## Origins

Based on [mcp-abap-abap-adt-api](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) by **[Mario Andreschak](https://github.com/mario-andreschak)** and the [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) library by **[Marcello Urbani](https://github.com/marcellourbani)**.

Dassian's fork adds input validation, error intelligence, MCP elicitation, session recovery, and a test suite. See [CHANGES.md](CHANGES.md) for the full list.

## What It Does

25 tools covering the full ABAP development lifecycle:

| Category | Tools | What They Do |
|----------|-------|-------------|
| **Source** | `abap_get_source`, `abap_set_source`, `abap_get_function_group` | Read/write ABAP source for any object type. Function group tool fetches all includes and FMs in one call. |
| **Objects** | `abap_create`, `abap_delete`, `abap_activate`, `abap_search`, `abap_object_info` | Full object lifecycle. Create in $TMP or real packages. Automatic type mapping (CLAS -> CLAS/OC). |
| **Transports** | `transport_create`, `transport_assign`, `transport_release`, `transport_list`, `transport_info`, `transport_contents` | Create, populate, and release transports. Smart metadata handling for FUGR/VIEW/TABL. |
| **Quality** | `abap_syntax_check`, `abap_atc_run` | Syntax check and ATC with variant support. Workaround for CI-mode systems. |
| **Data** | `abap_table`, `abap_query` | Read tables/CDS views with WHERE/LIKE/BETWEEN. Execute freestyle SQL. |
| **Run** | `abap_run` | Create temp class, run ABAP code, capture output, clean up. Auto-detects ~run vs ~main across SAP releases. |
| **System** | `login`, `healthcheck`, `abap_get_dump`, `raw_http` | Session management, connectivity test, ST22 dumps, raw ADT access. |
| **Git** | `git_repos`, `git_pull` | gCTS repository listing and pull. |

## Quick Start

### Prerequisites

- Node.js 18+
- Access to an SAP system with ADT enabled (port 44300)
- SAP user with development authorization

### Install

```bash
git clone https://github.com/DassianInc/dassian-adt.git
cd dassian-adt
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Edit .env with your SAP connection details:
#   SAP_URL=https://your-sap-server:44300
#   SAP_USER=YOUR_USER
#   SAP_PASSWORD=YOUR_PASSWORD
#   SAP_CLIENT=100
#   SAP_LANGUAGE=EN
```

For self-signed certificates, add to your `.env`:
```
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Connect to Claude Code

Add to your Claude Code MCP settings (`~/.config/claude-code/config.json` or project `.claude/settings.local.json`):

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap-server:44300",
        "SAP_USER": "YOUR_USER",
        "SAP_PASSWORD": "YOUR_PASSWORD",
        "SAP_CLIENT": "100",
        "SAP_LANGUAGE": "EN"
      }
    }
  }
}
```

Multiple systems? Add one entry per system:

```json
{
  "mcpServers": {
    "abap-dev": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": { "SAP_URL": "https://dev-system:44300", "SAP_USER": "...", "SAP_PASSWORD": "..." }
    },
    "abap-qa": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": { "SAP_URL": "https://qa-system:44300", "SAP_USER": "...", "SAP_PASSWORD": "..." }
    }
  }
}
```

### HTTP Mode (Team Deployment)

For team-wide access, run the server as a centralized HTTP service:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 \
  SAP_URL=https://your-sap-server:44300 \
  SAP_USER=SERVICE_USER \
  SAP_PASSWORD=... \
  node dist/index.js
```

Each client gets its own MCP session (and SAP session). Health check at `http://your-server:3000/health`.

Connect from Claude Code using the remote URL:

```json
{
  "mcpServers": {
    "abap": {
      "type": "url",
      "url": "http://your-server:3000/mcp"
    }
  }
}
```

Or register as a team integration on claude.ai for the whole org.

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` (local) or `http` (remote) |
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path |

### Test

```bash
npm test              # 165 unit tests, <3 seconds, no SAP needed
npm run test:live     # Integration tests against live SAP (needs env vars)
npm run test:e2e      # Write-path lifecycle test (create -> write -> activate -> delete)
```

## Key Features

### Zero-Crash Input Validation

Centralized validation middleware checks every tool's required parameters before any handler logic runs. Missing `name`? Missing `type`? The error names exactly what's missing. No stack traces, no `Cannot read properties of undefined`.

### MCP Elicitation

When the AI forgets a required parameter, instead of failing, the server asks the user directly:

- **Missing package** on `abap_create` -> "Which package?" form with $TMP default
- **Missing transport** on `abap_set_source` -> "Which transport?" prompt, then retries
- **Transport release** -> "Release D25K900161? This is IRREVERSIBLE" confirmation
- **Leftover class** on `abap_run` -> "Delete ZCL_TMP_ADT_RUN and retry?" prompt
- **Inactive dependents** on `abap_activate` -> "Activate them too?" with list

Falls back gracefully on clients that don't support elicitation.

### Self-Correcting Error Messages

Every SAP error is classified and annotated with actionable hints:

- Locked object -> "Check SM12 for active locks"
- Upgrade mode -> "Run SPAU_ENH to clear the upgrade flag"
- Opaque `I::000` code -> "The URL path is wrong -- check the object type"
- Transport number passed as object name -> "Use transport_contents instead"
- Pipe characters in string templates -> "Escape with \\| or use CONCATENATE"

The AI reads these hints and self-corrects on the next call.

### Automatic Session Recovery

Every ADT call is wrapped in `withSession()`. If the SAP session expires mid-operation, the server re-logs in automatically and retries. Users never see a session timeout.

### SAP Release Detection

`abap_run` auto-detects whether the system uses `IF_OO_ADT_CLASSRUN~run` (<=2023) or `~main` (2024+) by reading the interface source after login. Works on any S/4HANA release without configuration.

## Architecture

```
Client (Claude Code, VS Code, etc.)
    |
    | MCP protocol (stdio)
    |
AbapAdtServer (index.ts)
    |
    +-- BaseHandler (session mgmt, validation, elicitation)
    |       |
    |       +-- SourceHandlers    (get/set source, function groups)
    |       +-- ObjectHandlers    (create, delete, activate, search)
    |       +-- TransportHandlers (create, assign, release, list)
    |       +-- QualityHandlers   (syntax check, ATC)
    |       +-- DataHandlers      (table read, SQL query)
    |       +-- RunHandlers       (temp class execution)
    |       +-- SystemHandlers    (login, healthcheck, dumps)
    |       +-- GitHandlers       (gCTS repos, pull)
    |
    +-- lib/urlBuilder.ts  (ADT URL construction for 30+ object types)
    +-- lib/errors.ts      (SAP error classification + hints)
    +-- lib/logger.ts      (JSON structured logging)
```

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Run `npm test` and ensure all tests pass
4. Open a pull request

## Credits

- **[Mario Andreschak](https://github.com/mario-andreschak)** -- original [mcp-abap-abap-adt-api](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) server scaffold
- **[Marcello Urbani](https://github.com/marcellourbani)** -- [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) library powering all ADT HTTP communication
- **[Dassian Inc.](https://github.com/DassianInc)** -- fork maintainer

## License

MIT -- see [LICENSE](LICENSE).
