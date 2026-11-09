# Variant inputs

Status: **draft** · 2026-11-09
Touches: model-catalog (schema, validator), swiss (catalog, site profile, compose), console (deploy form)

## 1. Summary

A variant's `values` are its defaults. Some values a variant needs but cannot
know, such as the address of a service the site runs. The variant declares
those in `requires.inputs`, and swiss answers each one at two levels:

1. **Site**: the profile's `features.inputs`, keyed by chart path, with
   templates. These answers go into the derived layer.
2. **Deployer**: the deploy form shows every input with the site's answer as
   its default, and the deployer can override any of them. Overrides go into
   the form layer.

Compose refuses a plan that leaves an input unanswered. The workflow stays
compose → diff → apply, and swiss's API and plan format do not change.

`model.localPath` already works this way for one fixed value: the site's
`model.pathTemplate` answers it, and the deploy form's `localPath` overrides it.
Inputs make the same pattern declarable for any chart value.

## 2. Why

A variant has no way to say "supplied at deploy", so today it writes a
placeholder or one cluster's value instead:

| Variant | Value |
|---|---|
| `deepseek-v4-flash-0731-nvfp4/sglang-tp8-l3-6000d` | `storageKVOffload.mooncake.master: mooncake-master.example:50051` |
| `deepseek-v4-flash-0731-nvfp4/sglang-tp8-pd-l3-6000d` | the same placeholder |
| `glm5.3/sglang-tp8-pp2-ep8-pd-l3-6000d` | `storageKVOffload.mooncake.master: ""` |

## 3. Catalog: `requires.inputs`

Added to `$defs.variant.properties.requires` in `schema/version.schema.json`.
The v2 variant and index schemas reference that definition, so they pick it up.

```yaml
requires:
  gpus: 8
  inputs:
    - path: storageKVOffload.mooncake.master   # the chart value, dotted
      title: Mooncake master
      description: host:port of the Mooncake Store master this KV tier uses.
      type: string                             # string (default), integer or boolean
      pattern: '[^\s:/]+:[0-9]+'               # a string answer matches it, whole
      example: mooncake-master.example:50051   # required; never deployed
```

- **`example`** is the form's placeholder and the value CI renders the chart
  with. It is never deployed.
- **`model.localPath` cannot be declared**: swiss already answers it from
  `model.pathTemplate`.
- **Every input is required.** A value that's fine to leave as is belongs in
  `values`.

**Validator** (`hack/validate-schema.js`), for every v2 variant:

- paths are unique within a variant;
- `values` sets nothing at an input's path, or under it;
- `pattern` compiles, and appears only on a string input;
- `example` matches the input's type and pattern.

**validate:helm**: `catalogValues` sets each input to its `example`, so CI
renders every path that swiss would fill at deploy.

## 4. Site profile: `features.inputs`

```yaml
features:
  inputs:
    storageKVOffload.mooncake.master: mooncake-master.svc:50051
    storageKVOffload.mooncake.te_meta_data_server: http://mooncake-master.svc:8080/metadata
```

- **Keys are chart paths.** An answer applies only to a variant that declares
  that path. That is the difference from `extra`, which lands in every deploy.
- **Templates.** A string answer can use the placeholders `model.pathTemplate`
  already supports: `{{hf}}`, `{{org}}`, `{{name}}` and `{{model}}`. Parsing
  refuses a profile with an unknown placeholder.
- **One answer per path.** Parsing refuses a profile that sets the same path in
  both `extra` and `features.inputs`.
- **Separate from `defaults.features`**, which holds the site's on/off defaults
  for chart features.

## 5. swiss

- **Catalog**: `catalog.Requires` gains `Inputs`. swiss repeats the validator's
  rules when it loads a variant, because the catalog is untrusted input where
  it is used.
- **Profile**: `site.Profile` gains `Features.Inputs`, checked as in §4.
- **Compose**:
  1. For each declared input, the site's answer, with its template expanded,
     goes into the derived layer, unless the catalog or site layer already sets
     the path.
  2. Once all layers are assembled, each declared input must have a value of
     its type that matches its pattern. If not, compose fails, for example:
     `storageKVOffload.mooncake.master (Mooncake master) is not set: set it in
     the deploy's overrides, or features.inputs in the site profile`.
- **Upgrade**: `carryForward` keeps the form layer, so the deployer's answers
  persist. Site answers are derived again from the current profile.

## 6. Console: the deploy form

- **Renders every declared input**: its title and description, the example as
  a placeholder, and the pattern as client-side validation.
- **Prefills the site's answer**, from the profile the form already reads, with
  the template expanded using the same placeholders.
- **Sends only the inputs the deployer changed**, as overrides at their paths.
  An untouched field stays a site answer, so a profile change reaches the
  release on its next upgrade.
- **The upgrade form** shows the release's own answers from its form layer.

## 7. Rollout

1. **swiss and the console**, on every site. An older swissd refuses unknown
   keys in a v2 variant and in the v2 index, and the index would fail whole.
2. **model-catalog**: the schema, the validator and validate:helm. This can
   land at any time, because no variant uses inputs yet.
3. **Sites**: set `features.inputs`.
4. **Variants**: replace the placeholders in §2 with declared inputs, one
   commit, each variant bumping its patch version.

## 8. Later

- **Inputs inside lists** (`env`, `extraArgs`): an input path cannot address
  one list item. A standalone chart fix (map-shaped `env` and `extraArgs`)
  handles this. After it lands, the host NIC (13 variants) and the Mooncake
  settings in `kimi-k3/vllm-tp8-b300`'s env become inputs.
- **Other site-specific values found in variants**: the RDMA device resource,
  EBOF placement, HCA names, engine-cache hostPaths and Ascend runtime mounts.
