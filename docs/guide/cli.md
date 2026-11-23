# The CLI

`npx propmaster` scaffolds projects, checks test conventions, hands out TestCaseIDs, ranks flaky tests, generates API tests and starts the MCP server. `npx propmaster --help` lists every command and option.

```
  ┌─┐┬─┐┌─┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐
  ├─┘├┬┘│ │├─┘│││├─┤└─┐ │ ├┤ ├┬┘
  ┴  ┴└─└─┘┴  ┴ ┴┴ ┴└─┘ ┴ └─┘┴└─
  v1.0.0

? What do you want to do? ↑/↓ move · enter pick · type to filter
❯ init  scaffold the test layout here
  organize  see where existing tests belong
  generate openapi  API tests from the OpenAPI spec
  ...
```

## Interactive use

Run `npx propmaster` with no command in a terminal and it offers the commands in a menu. Commands ask for what you leave out, with a menu wherever the answer is one of a fixed list:

```bash
npx propmaster next-id          # pick the category from a menu, each with its next free ID
npx propmaster next-id API      # no menu: prints TC-API-005
```

| Prompt | Keys |
|---|---|
| Pick one | <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to pick, type to filter, <kbd>Backspace</kbd> to widen the filter again |
| Pick several | the same, and <kbd>Space</kbd> to select or clear an item |
| Yes or no | <kbd>y</kbd>, <kbd>n</kbd>, or <kbd>Enter</kbd> for the answer shown in capitals |
| Text | type, <kbd>Backspace</kbd>, <kbd>Ctrl</kbd>+<kbd>U</kbd> to clear; <kbd>Enter</kbd> takes the default in brackets |

<kbd>Esc</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd> cancels (exit code 130).

Menus are drawn on stderr, so a command's own output can still be piped: `npx propmaster next-id | pbcopy` asks for the category, then copies only the ID.

## In scripts and CI

Every answer can be given as an argument or flag, and then nothing is asked. With no terminal to ask in (stdin or stderr isn't a terminal, or `CI` is set), a command never waits: it stops with exit code 2 and says which flag to pass.

## Banner and version

Commands you run yourself (`init`, `organize`, `auth-setup`, `generate`, `flaky`, `--help`) start with the logo and version. It's left out when the output isn't a terminal, in CI, with `--json` or `--quiet`, and when `PROPMASTER_NO_BANNER` is set. `propmaster mcp` never prints it: its output is the MCP protocol.

```bash
npx propmaster --version        # or -v: prints just the version, e.g. 1.0.0
```

Colours follow [NO_COLOR](https://no-color.org): `NO_COLOR=1` turns them off, `FORCE_COLOR=1` on when the output isn't a terminal.
