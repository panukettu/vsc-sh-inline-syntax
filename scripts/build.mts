// Generates the grammars, language configs, and refreshes package.json contributes.
// Run: npm run build  (Node 22.18+ / 23.6+ runs TypeScript directly; erasable syntax only.)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Rule = { [key: string]: Json };
type Captures = { [group: string]: Rule };

const EXT = join(import.meta.dirname, "..");

function dump(rel: string, obj: Json): void {
  const path = join(EXT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

// Number of capture groups in an Oniguruma pattern. JS has no possessive
// quantifiers, but dropping them doesn't change the group count.
function captureGroups(pattern: string): number {
  return new RegExp(pattern.replaceAll("++", "+") + "|").exec("")!.length - 1;
}

// ---------------------------------------------------------------- injection

// Options before a command's program: -x / --long, each followed by up to two
// values (jq's `--arg name "$value"`). Values can't start with a quote or dash
// and stop at shell operators, so a match never runs past a pipe.
const VALUE = String.raw`[^'\s|;&<>()-][^\s|;&<>()]*`;
const OPT = String.raw`-\S+(?:\s+` + VALUE + String.raw`){0,2}`;
const OPTS = String.raw`(?:\s+` + OPT + String.raw`)*\s+(')`;
// The shell grammar starts an option token at the whitespace before the dash,
// so long-option rules must start there too to win.
const longOpt = (name: string) => String.raw`(?:^|[ \t]++)(--${name})(?:=|[ \t]+)`;

const QUOTE_BEGIN: Rule = { name: "punctuation.definition.string.begin.shell" };
const QUOTE_END: Rule = { name: "punctuation.definition.string.end.shell" };
const OPTION: Rule = { name: "string.unquoted.argument.shell constant.other.option.shell" };

function embedded(lang: string, extraPatterns: Rule[] = []): Rule[] {
  return [...extraPatterns, { include: `source.${lang}` }];
}

/**
 * Program in quotes after `begin` (which must end with the opening quote group).
 *
 * A program that closes on the same line is matched in one go and tokenized
 * inside a capture, so it can't leak past the closing quote even when the
 * embedded grammar has rules that run to end of line (Python's `from ... import`).
 * Multi-line programs fall back to begin/end, where that leak is possible.
 */
function quoted(
  begin: string,
  lang: string,
  quote: string,
  body: string,
  extraCaptures: Captures = {},
  extraPatterns: Rule[] = [],
): Rule[] {
  const quoteGroup = captureGroups(begin);
  const captures: Captures = { [quoteGroup]: QUOTE_BEGIN, ...extraCaptures };
  return [
    {
      match: begin + `(${body})(${quote})`,
      captures: {
        ...captures,
        [quoteGroup + 1]: {
          name: `meta.embedded.block.${lang}`,
          patterns: embedded(lang, extraPatterns),
        },
        [quoteGroup + 2]: QUOTE_END,
      },
    },
    {
      begin,
      beginCaptures: captures,
      end: quote,
      endCaptures: { 0: QUOTE_END },
      contentName: `meta.embedded.block.${lang}`,
      patterns: embedded(lang, extraPatterns),
    },
  ];
}

function singleQuoted(begin: string, lang: string, extraCaptures: Captures = {}): Rule[] {
  return quoted(begin, lang, "'", "[^']*", extraCaptures);
}

/** `--name '...'`, `--name "..."` (shell expansions kept) and `--name word`. */
function longOption(name: string, lang: string): Rule[] {
  const prefix = longOpt(name);
  const shellExpansions: Rule[] = [
    { include: "source.shell#double_quote_escape_char" },
    { include: "source.shell#interpolation" },
    { include: "source.shell#variable" },
  ];
  return [
    ...singleQuoted(prefix + "(')", lang, { 1: OPTION }),
    ...quoted(prefix + '(")', lang, '"', String.raw`(?:\\.|[^"\\])*`, { 1: OPTION }, shellExpansions),
    {
      match: prefix + String.raw`([^\s'"|;&<>()\\$` + "`]+)",
      captures: {
        1: OPTION,
        2: { name: `meta.embedded.inline.${lang}`, patterns: embedded(lang) },
      },
    },
  ];
}

const injection: Rule = {
  scopeName: "shell.inline-syntax.injection",
  injectionSelector: "L:source.shell -comment",
  patterns: [
    ...singleQuoted(String.raw`\b[gmn]?awk` + OPTS, "awk"),
    ...singleQuoted(String.raw`\bjq` + OPTS, "jq"),
    ...longOption("jq", "jq").slice(0, 2), // gh api --jq '...'
    ...singleQuoted(String.raw`\bpython[0-9.]*(?:\s+-[^\s'c]\S*)*\s+-c\s+(')`, "python"),
    // BSD sed's in-place flag takes an empty '' suffix: sed -i '' 's/a/b/'
    ...singleQuoted(String.raw`\bsed(?:\s+(?:-i\s*''|` + OPT + String.raw`))*\s+(')`, "sed"),
    ...singleQuoted(String.raw`\bjpx?` + OPTS, "jmespath"),
    ...longOption("query", "jmespath"), // aws/az --query
  ],
};

// ----------------------------------------------------------------- JMESPath

const STANDARD_FUNCTIONS = (
  "abs avg ceil contains ends_with floor join keys length map max max_by merge " +
  "min min_by not_null reverse sort sort_by starts_with sum to_array to_number " +
  "to_string type values"
).split(" ");
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

const jmespath: Rule = {
  name: "JMESPath",
  scopeName: "source.jmespath",
  patterns: [
    { include: "#jpx-directive" },
    { include: "#comment" },
    { include: "#expression" },
  ],
  repository: {
    // .jpx query libraries: `-- :name query-name`, `-- :desc text`
    "jpx-directive": {
      patterns: [
        {
          match: String.raw`^\s*(--)\s*(:name)\b\s*(.*?)\s*$`,
          captures: {
            1: { name: "punctuation.definition.comment.jmespath" },
            2: { name: "keyword.other.directive.jmespath" },
            3: { name: "entity.name.function.query.jmespath" },
          },
        },
        {
          match: String.raw`^\s*(--)\s*(:desc(?:ription)?)\b\s*(.*)$`,
          captures: {
            1: { name: "punctuation.definition.comment.jmespath" },
            2: { name: "keyword.other.directive.jmespath" },
            3: { name: "comment.line.double-dash.jmespath" },
          },
        },
      ],
    },
    comment: {
      match: String.raw`^\s*(--)(?:\s.*)?$`,
      name: "comment.line.double-dash.jmespath",
      captures: { 1: { name: "punctuation.definition.comment.jmespath" } },
    },
    expression: {
      patterns: [
        { include: "#let" },
        { include: "#literal" },
        { include: "#raw-string" },
        { include: "#quoted-identifier" },
        { include: "#variable" },
        { include: "#function-call" },
        { include: "#hash-key" },
        { include: "#number" },
        { include: "#operator" },
        { include: "#punctuation" },
        { match: IDENT, name: "variable.other.property.jmespath" },
      ],
    },
    // JEP-18 lexical scoping: let $a = expr, $b = expr in expr
    let: {
      begin: String.raw`\b(let)(?=\s+\$)`,
      beginCaptures: { 1: { name: "keyword.control.let.jmespath" } },
      end: String.raw`\b(in)\b`,
      endCaptures: { 1: { name: "keyword.control.in.jmespath" } },
      patterns: [{ include: "#expression" }],
    },
    literal: {
      begin: "`",
      beginCaptures: { 0: { name: "punctuation.definition.literal.begin.jmespath" } },
      end: "`",
      endCaptures: { 0: { name: "punctuation.definition.literal.end.jmespath" } },
      contentName: "meta.embedded.inline.json",
      patterns: [
        { match: "\\\\`", name: "constant.character.escape.jmespath" },
        { include: "source.json" },
      ],
    },
    "raw-string": {
      begin: "'",
      end: "'",
      beginCaptures: { 0: { name: "punctuation.definition.string.begin.jmespath" } },
      endCaptures: { 0: { name: "punctuation.definition.string.end.jmespath" } },
      name: "string.quoted.single.jmespath",
      patterns: [{ match: String.raw`\\['\\]`, name: "constant.character.escape.jmespath" }],
    },
    "quoted-identifier": {
      begin: '"',
      end: '"',
      beginCaptures: { 0: { name: "punctuation.definition.string.begin.jmespath" } },
      endCaptures: { 0: { name: "punctuation.definition.string.end.jmespath" } },
      name: "string.quoted.double.jmespath",
      patterns: [
        {
          match: String.raw`\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})`,
          name: "constant.character.escape.jmespath",
        },
      ],
    },
    variable: {
      patterns: [
        {
          match: String.raw`(\$)` + IDENT,
          name: "variable.other.readwrite.jmespath",
          captures: { 1: { name: "punctuation.definition.variable.jmespath" } },
        },
        { match: String.raw`\$(?![A-Za-z_])`, name: "variable.language.root.jmespath" },
        { match: "@", name: "variable.language.current.jmespath" },
      ],
    },
    // Standard functions are scoped apart from jpx extensions, so themes
    // show which calls won't work with `jpx --strict` or the AWS CLI.
    "function-call": {
      patterns: [
        {
          match: String.raw`\b(` + STANDARD_FUNCTIONS.join("|") + String.raw`)(?=\s*\()`,
          name: "support.function.builtin.jmespath",
        },
        { match: String.raw`\b` + IDENT + String.raw`(?=\s*\()`, name: "entity.name.function.jmespath" },
      ],
    },
    "hash-key": {
      match: String.raw`\b(` + IDENT + String.raw`)\s*(?=:)`,
      captures: { 1: { name: "support.type.property-name.jmespath" } },
    },
    number: { match: String.raw`-?\b\d+\b`, name: "constant.numeric.integer.jmespath" },
    operator: {
      patterns: [
        { match: String.raw`\|\||&&`, name: "keyword.operator.logical.jmespath" },
        { match: "==|!=|<=|>=|<|>", name: "keyword.operator.comparison.jmespath" },
        { match: "!", name: "keyword.operator.logical.jmespath" },
        { match: "&", name: "keyword.operator.expression-reference.jmespath" },
        { match: String.raw`\|`, name: "keyword.operator.pipe.jmespath" },
        {
          match: String.raw`(\[)(\?)`,
          captures: {
            1: { name: "punctuation.section.brackets.begin.jmespath" },
            2: { name: "keyword.operator.filter.jmespath" },
          },
        },
        { match: String.raw`\[\]`, name: "keyword.operator.flatten.jmespath" },
        { match: String.raw`\*`, name: "keyword.operator.wildcard.jmespath" },
        { match: String.raw`//|[+\-/%]`, name: "keyword.operator.arithmetic.jmespath" },
      ],
    },
    punctuation: {
      patterns: [
        { match: String.raw`\.`, name: "punctuation.accessor.jmespath" },
        { match: ",", name: "punctuation.separator.comma.jmespath" },
        { match: ":", name: "punctuation.separator.colon.jmespath" },
        { match: String.raw`[\[\]{}()]`, name: "punctuation.section.brackets.jmespath" },
      ],
    },
  },
};

// ---------------------------------------------------------------------- sed

// Body of a delimited section (s/HERE/, y/HERE/, \%HERE%): anything up to the
// delimiter captured as group 2, allowing escapes.
const SECTION = String.raw`((?:\\.|(?!\2)[^\\])*)`;
const ESCAPES: Rule[] = [{ match: String.raw`\\.`, name: "constant.character.escape.sed" }];

const sed: Rule = {
  name: "sed",
  scopeName: "source.sed",
  patterns: [{ include: "#script" }],
  repository: {
    script: {
      patterns: [
        { include: "#comment" },
        { include: "#substitute" },
        { include: "#transliterate" },
        { include: "#address" },
        { include: "#text-command" },
        { include: "#file-command" },
        { include: "#label" },
        { include: "#command" },
      ],
    },
    comment: {
      match: String.raw`(?:^|(?<=[;{}]))\s*(#).*$`,
      name: "comment.line.number-sign.sed",
      captures: { 1: { name: "punctuation.definition.comment.sed" } },
    },
    substitute: {
      match:
        String.raw`(s)([^\w\s\\])` + SECTION + String.raw`(\2)` + SECTION +
        String.raw`(\2)([gpiImMe0-9]*(?:w\s+\S+)?)`,
      captures: {
        1: { name: "keyword.control.command.sed" },
        2: { name: "punctuation.definition.delimiter.sed" },
        3: { name: "string.regexp.sed", patterns: [{ include: "#regexp" }] },
        4: { name: "punctuation.definition.delimiter.sed" },
        5: { name: "string.other.replacement.sed", patterns: [{ include: "#replacement" }] },
        6: { name: "punctuation.definition.delimiter.sed" },
        7: { name: "storage.modifier.flag.sed" },
      },
    },
    transliterate: {
      match: String.raw`(y)([^\w\s\\])` + SECTION + String.raw`(\2)` + SECTION + String.raw`(\2)`,
      captures: {
        1: { name: "keyword.control.command.sed" },
        2: { name: "punctuation.definition.delimiter.sed" },
        3: { name: "string.other.characters.sed", patterns: ESCAPES },
        4: { name: "punctuation.definition.delimiter.sed" },
        5: { name: "string.other.characters.sed", patterns: ESCAPES },
        6: { name: "punctuation.definition.delimiter.sed" },
      },
    },
    address: {
      patterns: [
        {
          match: String.raw`(/)((?:\\.|[^/\\])*)(/)([IM]*)`,
          captures: {
            1: { name: "punctuation.definition.delimiter.sed" },
            2: { name: "string.regexp.address.sed", patterns: [{ include: "#regexp" }] },
            3: { name: "punctuation.definition.delimiter.sed" },
            4: { name: "storage.modifier.flag.sed" },
          },
        },
        {
          match: String.raw`(\\)([^\w\s\\])` + SECTION + String.raw`(\2)([IM]*)`,
          captures: {
            1: { name: "punctuation.definition.delimiter.sed" },
            2: { name: "punctuation.definition.delimiter.sed" },
            3: { name: "string.regexp.address.sed", patterns: [{ include: "#regexp" }] },
            4: { name: "punctuation.definition.delimiter.sed" },
            5: { name: "storage.modifier.flag.sed" },
          },
        },
        { match: String.raw`\d+`, name: "constant.numeric.line-number.sed" },
        { match: String.raw`\$`, name: "constant.language.last-line.sed" },
        { match: "[,~]", name: "keyword.operator.range.sed" },
        { match: "!", name: "keyword.operator.negation.sed" },
      ],
    },
    // a/i/c take text: `a\` continues on following lines (each ending in
    // a backslash), GNU `a text` takes the rest of the line.
    "text-command": {
      patterns: [
        {
          begin: String.raw`(?<![A-Za-z\\])([aic])(\\)$`,
          beginCaptures: {
            1: { name: "keyword.control.command.sed" },
            2: { name: "constant.character.escape.sed" },
          },
          // lines are tokenized with a trailing \n; don't end right after it
          end: String.raw`(?<![\\\n])$`,
          contentName: "string.unquoted.text.sed",
        },
        {
          match: String.raw`(?<![A-Za-z\\])([aic])(\\?)\s*(.*)$`,
          captures: {
            1: { name: "keyword.control.command.sed" },
            2: { name: "constant.character.escape.sed" },
            3: { name: "string.unquoted.text.sed" },
          },
        },
      ],
    },
    "file-command": {
      match: String.raw`(?<![A-Za-z\\])([rRwW])\s+(\S.*)$`,
      captures: {
        1: { name: "keyword.control.command.sed" },
        2: { name: "string.unquoted.filename.sed" },
      },
    },
    label: {
      patterns: [
        {
          match: String.raw`(:)\s*([^;\s]+)`,
          captures: {
            1: { name: "punctuation.definition.label.sed" },
            2: { name: "entity.name.label.sed" },
          },
        },
        {
          match: String.raw`(?<![A-Za-z\\])([btT])(?:\s*([^;}\s]+))?`,
          captures: {
            1: { name: "keyword.control.branch.sed" },
            2: { name: "entity.name.label.sed" },
          },
        },
      ],
    },
    command: {
      patterns: [
        { match: "[=dDeFgGhHlnNpPqQxz]", name: "keyword.control.command.sed" },
        { match: "[{}]", name: "punctuation.section.block.sed" },
        { match: ";", name: "punctuation.terminator.command.sed" },
      ],
    },
    regexp: {
      patterns: [
        { match: String.raw`\\[1-9]`, name: "keyword.other.back-reference.regexp" },
        { match: String.raw`\\[()]|[()]`, name: "punctuation.definition.group.regexp" },
        {
          match: String.raw`\\\{[0-9,]*\\\}|\{[0-9,]*\}|\\?[+?]|\*`,
          name: "keyword.operator.quantifier.regexp",
        },
        { match: String.raw`\\\||\|`, name: "keyword.operator.or.regexp" },
        { match: String.raw`\\.`, name: "constant.character.escape.regexp" },
        {
          match: String.raw`\[\^?\]?(?:\[:\w+:\]|[^\]])*\]`,
          name: "constant.other.character-class.set.regexp",
        },
        { match: String.raw`[\^$]`, name: "keyword.control.anchor.regexp" },
        { match: String.raw`\.`, name: "constant.character.wildcard.regexp" },
      ],
    },
    replacement: {
      patterns: [
        { match: "&", name: "variable.language.match.sed" },
        { match: String.raw`\\[0-9]`, name: "variable.other.back-reference.sed" },
        { match: String.raw`\\[ULluE]`, name: "keyword.other.case.sed" },
        { match: String.raw`\\.`, name: "constant.character.escape.sed" },
      ],
    },
  },
};

// ------------------------------------------------------------------ package

const languageConfig: { [lang: string]: Rule } = {
  jmespath: {
    comments: { lineComment: "--" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string"] },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "`", close: "`", notIn: ["string"] },
    ],
    surroundingPairs: [["{", "}"], ["[", "]"], ["(", ")"], ["'", "'"], ['"', '"'], ["`", "`"]],
  },
  sed: {
    comments: { lineComment: "#" },
    brackets: [["{", "}"]],
    autoClosingPairs: [{ open: "{", close: "}" }],
  },
};

const contributes: Rule = {
  languages: [
    {
      id: "jmespath",
      aliases: ["JMESPath", "jpx"],
      extensions: [".jp", ".jpx"],
      configuration: "./language-configuration/jmespath.json",
    },
    {
      id: "sed",
      aliases: ["sed"],
      extensions: [".sed"],
      firstLine: String.raw`^#!.*\bsed\b`,
      configuration: "./language-configuration/sed.json",
    },
  ],
  grammars: [
    { language: "jmespath", scopeName: "source.jmespath", path: "./syntaxes/jmespath.tmLanguage.json" },
    { language: "sed", scopeName: "source.sed", path: "./syntaxes/sed.tmLanguage.json" },
    {
      scopeName: "shell.inline-syntax.injection",
      path: "./syntaxes/shell-injection.tmLanguage.json",
      injectTo: ["source.shell"],
      embeddedLanguages: {
        "meta.embedded.block.awk": "awk",
        "meta.embedded.block.jq": "jq",
        "meta.embedded.block.python": "python",
        "meta.embedded.block.sed": "sed",
        "meta.embedded.block.jmespath": "jmespath",
        "meta.embedded.inline.jmespath": "jmespath",
      },
    },
  ],
};

dump("syntaxes/shell-injection.tmLanguage.json", injection);
dump("syntaxes/jmespath.tmLanguage.json", jmespath);
dump("syntaxes/sed.tmLanguage.json", sed);
for (const [lang, cfg] of Object.entries(languageConfig)) {
  dump(`language-configuration/${lang}.json`, cfg);
}

// Keep hand-maintained package.json metadata/scripts; only refresh contributes.
const pkgPath = join(EXT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Rule;
pkg.contributes = contributes;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const old = join(EXT, "awk-injection.json");
if (existsSync(old)) rmSync(old);
console.log("ok");
