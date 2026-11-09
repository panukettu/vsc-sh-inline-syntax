# sh-inline-syntax

Syntax highlighting for programs embedded in shell scripts:

- `awk` / `gawk` / `mawk` / `nawk '…'`
- `jq '…'` and `gh … --jq '…'`
- `python[3] -c '…'`
- `sed '…'` (including BSD `sed -i '' '…'`)
- `jp` / `jpx '…'` and `aws` / `az --query …`

Also adds standalone grammars for JMESPath (`.jp` / `.jpx`) and sed (`.sed`).

Depends on [Assorted Languages](https://marketplace.visualstudio.com/items?itemName=edwinkofler.vscode-assorted-languages) for the `awk` and `jq` grammars.

pair with [overload](https://marketplace.visualstudio.com/items?itemName=0xp.overload) for syntax colors
