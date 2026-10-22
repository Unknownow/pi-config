<!-- pi-workflow plan v1 flow=20261022-1518-explain-the-single-delivery-option-in-th-58a2 -->
## Plan: Explain the single delivery option in the plan-end approval menu

**1. Goal and non-goals**
- Goal: when the plan-end approval menu shows only one delivery option (because autopilot is on or `delivery.ask` is `false`), the label says why and how to change it. It no longer reads "(default)". `/flow status` uses the same wording when the delivery was set for this flow.
- Non-goals: the full four-option menu keeps its current labels. No change to what gets delivered, to config keys, to the `chooseDelivery` "After the judge passes" menu (autopilot skips it and returns the default), or to `docs/workflow-improvements.md`.

**2. User decisions**
- D1: Rename the "commit only (default)" label when it is the only option shown, so it explains why the other options are missing.
- D2: Wording: autopilot gives `<mode label> (autopilot · /flow delivery to change)`. `delivery.ask` false gives `<mode label> (delivery.ask off · /flow delivery to change)`. A mode set with `/flow delivery` gives `<mode label> (set for this flow · /flow delivery to change)`.
- D3: The four-option menu keeps `(default)`.
- D4: One stage, delivered as a single commit. No backlog row in `docs/workflow-improvements.md`.

**3. Facts**
- `pi/agent/extensions/workflow/delivery.ts:7-13`: `DELIVERY_LABELS`. `delivery.ts:24-26`: `deliveryMenuLabel(d, def)` adds `" (default)"`.
- `pi/agent/extensions/workflow/index.ts:3048-3050`: `def = menuDefault()`, `options = cfg.delivery.ask && !autopilotOn() ? deliveryChoices(def) : [def]`, `labels = options.map(d => "Approve → " + deliveryMenuLabel(d, def))`.
- `index.ts:3062-3063`: the choice is mapped back with `labels.indexOf(choice)` → `options[i]`, so any label text works as long as the same `labels` array is used.
- `index.ts:644-646`: `menuDefault()` returns `state.delivery ?? defaultDelivery()`. `state.delivery` is set by `/flow delivery <mode>` (`index.ts:4330-4342`) or by an earlier approval. `index.ts:350`: `autopilotOn()`.
- `index.ts:4050`: the `/flow status` judge line ends `${DELIVERY_LABELS[...]}${state.delivery ? "" : " (default)"}`.
- `delivery.test.ts:20-23`: test "menu label marks the default". The file runs with `node --test delivery.test.ts` (header line 1).
- `README.md:165`: the autopilot "Menus skipped" bullet lists "the plan-end approval's delivery choices".

**5. Steps**

**S1.** In `delivery.ts`, after `deliveryMenuLabel` (line 24), add an exported pure function and a type, modelled on `deliveryMenuLabel`:
```ts
export type FixedDeliveryReason = "autopilot" | "ask-off" | "flow";
export function fixedDeliveryLabel(d: Delivery, reason: FixedDeliveryReason): string
```
It returns `${DELIVERY_LABELS[d]} (<reason text> · /flow delivery to change)`. The reason text is `autopilot`, `delivery.ask off` or `set for this flow`. The `·` is U+00B7 with one space on each side. Add a one-line doc comment saying this is the label used when the menu collapses to one option.

**S2.** In `index.ts`, plan-end menu (around 3048-3050), when the menu has only one option (autopilot on or `cfg.delivery.ask` false):
- The reason is `"flow"` if `state.delivery` is set. Otherwise it is `"autopilot"` if `autopilotOn()`, else `"ask-off"`. When `state.delivery` is set, the menu shows the user's own choice, so "set for this flow" is the more useful hint.
- The label is `Approve → ${fixedDeliveryLabel(def, reason)}`.
- The multi-option branch stays exactly as it is. Keep a single `labels` array so the `labels.indexOf(choice)` → `options[i]` mapping (3062-3063) still works. Import `fixedDeliveryLabel` in the existing import from `./delivery.ts` (line 57).

**S3.** In `index.ts:4050` (`statusText`), change the suffix to `" (set for this flow)"` when `state.delivery` is set and `" (default)"` when it isn't. Before, it was empty when set.

**S4.** In `README.md:165`, edit the "Menus skipped" bullet: the plan-end approval shows only the delivery mode that applies, with a label saying why (autopilot, or "set for this flow") and that `/flow delivery <mode>` changes it. Keep it to one clause.

**6. Tests**
- `delivery.test.ts`: add `fixedDeliveryLabel` to the import on line 4 and add a test "fixed label explains the single option":
  - `fixedDeliveryLabel("commit", "autopilot")` → `"commit only (autopilot · /flow delivery to change)"`
  - `fixedDeliveryLabel("commit", "ask-off")` → `"commit only (delivery.ask off · /flow delivery to change)"`
  - `fixedDeliveryLabel("merge", "flow")` → `"commit + push + pull request + merge (set for this flow · /flow delivery to change)"`
- Keep the existing "menu label marks the default" test unchanged.
- Run `cd pi/agent/extensions/workflow && node --test delivery.test.ts`. Expected: all tests pass, fail 0. Also run `node --test` over the folder's other `*.test.ts` files (`node --test *.test.ts`) and expect no new failures.
- Type check: if the repo has a `tsc`/typecheck setup for the extension, run it. Otherwise, `node --test` loading `index.ts` imports is enough.

**7. Done when**
- With autopilot on and no `/flow delivery`, the menu shows `Approve → commit only (autopilot · /flow delivery to change)`. Choosing it approves with `commit`.
- After `/flow delivery pr` with autopilot on, it shows `Approve → commit + push + pull request (set for this flow · /flow delivery to change)` and approves with `pr`.
- With `delivery.ask: false` and autopilot off, it shows the `delivery.ask off` wording.
- With `delivery.ask: true` and autopilot off, the menu is unchanged, with four options and `(default)` on the first.
- `/flow status` shows `(set for this flow)` or `(default)`.
- The new and existing tests pass. README is updated.

**8. Risks, rollback, don't touch**
- Risk: the label/option mapping breaks if `labels` and `options` drift apart. Keep them built from the same `options` array.
- Rollback: revert the single commit.
- Don't touch: `chooseDelivery` (`index.ts:648-662`), `deliveryChoices`, `DELIVERY_LABELS`, config defaults, `docs/workflow-improvements.md`.

**9. Commits**
- `workflow: explain the single delivery option in the approval menu`: `delivery.ts`, `delivery.test.ts`, `index.ts`, `README.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `delivery.ts`, after `deliveryMenuLabel` (line 24), add an exported pure function and a type, modelled on `deliveryMe
- [ ] S2 In `index.ts`, plan-end menu (around 3048-3050), when the menu has only one option (autopilot on or `cfg.delivery.ask` f
- [ ] S3 In `index.ts:4050` (`statusText`), change the suffix to `" (set for this flow)"` when `state.delivery` is set and `" (de
- [ ] S4 In `README.md:165`, edit the "Menus skipped" bullet: the plan-end approval shows only the delivery mode that applies, wi
