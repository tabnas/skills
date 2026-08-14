# Alternates and tokens — cheatsheet

Distilled from the tested fleet guides (choose-between-alternates,
recursion-and-repetition, custom-tokens, comments-and-whitespace,
strings-and-quoting) and the grammar schema. Everything here holds for the
portable JSON GrammarSpec unless marked "plugin code only".

## The alternate, field by field

An alternate (alt) is one entry in a rule phase's list. First matching alt
wins; no backtracking.

| Field | Type (portable JSON) | Meaning |
|---|---|---|
| `s` | string (`"#KEY #CL"`) or array of strings | Token sequence to match, in order. The alt matches only if **all** of it matches; a partial match costs nothing and the next alt is tried. String form: space-separated names, one slot each. Array form: each element is one slot, and space-separated names within an element are that slot's alternatives (`["#NR #ST"]` = one slot, either token). In TS plugin code one-slot alternation is a nested array (`[['#OB','#OS']]`) and a `null` position is a wildcard — neither is portable JSON: the schema's array items are strings only, and the Go loader does not implement nesting. |
| `p` | rule name or `@ref` | **Push** a child rule — depth grows, child's parent is this rule. Nesting. |
| `r` | rule name or `@ref` | **Replace** at the same depth — repetition. Every repetition has the same parent. |
| `b` | number or `@ref` | Push back N matched tokens: inspect without consuming (e.g. recognise `{`, push the map rule, hand the brace back). |
| `c` | `@ref` or condition object | Condition: the alt applies only if it holds. Use for state the tokens cannot express — e.g. "only a rule that opened on `(` may close on `)`". |
| `n` | object of **integers** | Counter set/increment. Counters propagate to pushed and repeated rules. Setting a counter to `0` resets it. Integers are the contract (one runtime tolerates floats; the other truncates). |
| `u` | object | Custom data attached to the rule instance. |
| `k` | object | Custom data propagated to child rules. |
| `g` | string or array | Group tags, for `rule.include` / `rule.exclude` dialect filtering. Each tag must match `^[a-z][a-z0-9-]+$` — note the `+`: a single-letter tag is invalid and throws. |
| `a` | `@ref` or array of `@ref`s | Action(s) run when the alt fires. In portable JSON these are function references only. |
| `e` | `@ref` | Error-token generator: an alt that exists to fail well, raising your own error code from the position that knows what went wrong. |
| `h` | `@ref` | Alternate modifier (advanced; plugin code only in practice). |

Rule-level: a rule spec is `{ "open": [...], "close": [...] }`; a `null` rule
entry **removes** the rule. The open/close value may also be
`{ "alts": [...], "inject": {...} }` where `inject` controls merging into
existing alternates: `append` (default prepend), `clear` (empty first),
`delete` (indices, negatives from the end), `move` ([from,to,...] pairs).
Top-level `clear: true` wipes rules and fixed tokens (lexer matchers stay).
Top-level `v` is the builtin config-schema version gate — absent means 1, and
an engine refuses a spec whose `v` exceeds what it implements.

## Ordering rules

- **Longer, more specific patterns first.** A shorter alt that is a prefix of
  a longer one starves it: the short one matches in full and the parse
  commits. Symptom: valid input rejected, error at column 1, empty character
  list.
- Sharing leading tokens across alts is fine — a sequence that fails on its
  third token abandons cleanly and the next alt still runs.
- **Lookahead is as long as `s` is.** Four tokens, six tokens — no limit (an
  old two-token claim is wrong). But lookahead never re-lexes: tokenisation is
  fixed before any alt sees it. If two constructs need the same text lexed
  differently, that is a lexer problem, not an ordering one.
- The **empty alt `{}`** matches anything, consumes nothing, ends a phase.
  Every phase needs one or a reachable terminator — no matching alt is a
  parse error. In a close phase an unconditional `{}` will end a rule that
  should have required its terminator: guard it with `c` or replace it with
  an `e` alt.

## Counters

- An unset counter reads as `0`; exactly one of `<`, `=`, `>` holds against
  any limit — so a guard means what it says wherever you put it, and a
  depth guard is typically a *negated* less-than, since the unset counter
  starts below any ceiling. (Before engine 0.6 an unset counter compared
  true against every limit, so guards had to hold in both directions at
  once.)
- Depth ceiling pattern: add `n: { "depth": 1 }` to the alts that push a
  structure, and put a guard alt **in front** of them that matches the same
  opening tokens with `b: 1` (inspect, don't consume), a `c` condition on the
  counter, and an `e` raising your `too_deep`-style code.
- `rule.maxmul` (default `3`) is the other backstop: total rule steps capped
  at a multiple of input length. It catches loops that don't consume, not
  nesting.

## Building values with the builtins

A portable spec builds a native value by naming the engine's `$`-suffixed
builtin actions in `a`. The mechanic (from the template's engine model):
allocate a container when a structure opens, fold each closed child into it,
and the final result is the start rule's node. The engine's own serialized
JSON-builder grammar — captured as a parser test fixture — is the placement
recipe to copy:

| Where it sits in that grammar | Builtin | Role |
|---|---|---|
| every `val` open alternate | `@reset$` | reset value state for the new value |
| `map` open (on `#OB`) | `@object$` | allocate the object |
| `list` open (on `#OS`) | `@array$` | allocate the array |
| `pair` open (`#KEY #CL`, pushing `val`) | `@key$` | record the pair's key |
| `pair` close (`#CA` repeat / `#CB` push-back) | `@setval$` | fold the closed child into the object |
| `elem` close (`#CA` repeat / `#CS` push-back) | `@push$` | fold the closed child into the array |
| `val` close (`#ZZ`, or `b: 1` otherwise) | `@value$` | settle the final value |

Two more moves that fixture makes, worth copying: it declares `"v": 2`, and
it narrows the token sets (`"tokenSet": { "KEY": ["#ST"], "VAL": ["#ST",
"#NR", "#VL"] }`) so only real JSON keys and values qualify. Any `@`-ref
without the `$` suffix is a custom function the JSON cannot carry — it must
arrive in a ref bag at load time.

## Built-in tokens

| Token | Source |
|---|---|
| `#OB` `#CB` | `{` `}` |
| `#OS` `#CS` | `[` `]` |
| `#CL` | `:` (key/value separator) |
| `#CA` | `,` — the comma. **`#CM` is comment, not comma.** |
| `#SP` `#LN` `#CM` | space run, newline run, comment — lexed then ignored |
| `#ZZ` | end of source (reported twice at the end: the parser peeks past the end; not a bug) |
| `#TX` | bareword / identifier |
| `#NR` | number (hex/oct/bin and `_` separators on by default) |
| `#ST` | quoted string |
| `#VL` | keyword value (`true`/`false`/`null` via `value.def`, or `match.value` results) |

Token sets: `IGNORE` is positional `[#SP, #LN, #CM]` — `null` drops an entry,
`undefined` leaves it (drop `#LN` for line-oriented formats; keeping `#CM`
means most rules need a comment alt). `VAL` and `KEY` (both
`[#TX, #NR, #ST, #VL]` by default) list which tokens may stand as a value or a
key.

## Declaring tokens — four ways, in effort order

1. **Fixed literal**: `fixed.token`, name → spelling. Longer literals beat
   shorter. Deliberately remapping a built-in is legitimate (CSV implements
   its separator option by remapping `#CA`); doing it by accident is not —
   check the name is free first.
2. **Regex token**: `match.token`, name → pattern. **Anchor with `^`.** A new
   token means every rule that should accept it needs an alt for it — right
   when the token is syntax, wasteful when it is a value.
3. **Value literal**: `match.value` (pattern + value function) or `value.def`
   (fixed words → values; a `null` entry removes a word, which is how a
   dialect drops `true` or `null`). Produces `#VL`, already in `VAL`, so it
   works everywhere a value works with no rule changes.
4. **Matcher function** (plugin code only): for non-regular tokens (heredocs,
   indentation). Registered under `lex.match.<name> = { order, make }` —
   lower `order` runs earlier, and the defaults run at match 1e6, fixed 2e6,
   space 3e6, line 4e6, string 5e6, comment 6e6, number 7e6, text 8e6. A
   matcher whose syntax shares a prefix with a built-in must out-order that
   built-in. Its two duties: advance the point by exactly what it consumed
   (rows/columns too if it can span a newline), and return undefined — not
   throw — when the input is not its.

## Comments

- Comment lexing is a switch: `comment.lex: true` turns on the three built-in
  styles `#`, `//`, `/* … */` (the whole difference between JSON and JSONC).
- Definitions are a map keyed by name (`hash`, `slash`, `multi`); set one to
  `null` to remove it; add your own with start/end markers.
- **A new comment definition must set `lex: true` on itself** — the outer
  switch does not supply it, and a definition without it is registered,
  ignored, and surfaces as `unexpected` on the marker. This is the single
  most common comment mistake.
- `eatline: true` makes a line comment swallow its newline — irrelevant while
  `#LN` is ignored, decisive in a line-oriented grammar.

## Strings

All configuration, no code: `string.chars` is the complete set of quote
characters (set it, don't append); `string.multiChars` lists which of them may
span lines (must also be in `chars`); `string.escapeChar` and `string.escape`
define the escape table (a `null` entry removes an escape);
`string.allowUnknown` decides whether an undefined escape errors (strict; the
JSON setting — prefer it for formats you control) or passes through (the
relaxed setting). Doubling-style quoting (CSV `""`) is not backslash-shaped
and needs its own matcher — the CSV plugin's is the model. Unterminated
strings raise their own code, `unterminated_string`, so they can carry their
own message.

## Left recursion and repetition in ABNF

If you author via `@tabnas/abnf`: a tail self-reference (`add = NR [ PL add ]`)
compiles to a flat repeat — three siblings for `1+2+3`, not three levels.
`*( … )` also repeats but desugars into a generated group rule, awkward for
actions. Left recursion (`P = P a / b`) is accepted and rewritten to iterative
form; the tree comes out flat (associativity is your action's job), actions on
the rewritten branches are look-up-only, and a purely left-recursive rule
(`P = P a` with no base) is a compile error. For operator precedence, do not
encode it as recursion at all — the fleet's expression plugin does it with
binding powers.
