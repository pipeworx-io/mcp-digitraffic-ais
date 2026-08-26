# @pipeworx/digitraffic-ais

Live vessel positions in Finnish and Baltic waters, from Fintraffic's AIS receivers. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `ais_vessels_near(...)` — vessels within a radius of a point, with position, speed, course, navigational status and type.
- `ais_area_count(...)` — how many vessels are in an area, broken down by ship type.
- `ais_vessel(...)` — latest position and voyage details for one vessel by MMSI.

## Auth

None.

## Coverage

**Regional, not worldwide.** Fintraffic's receivers cover Finland and the surrounding Baltic — Gulf of Finland, Gulf of Bothnia, Archipelago Sea, Åland — with fringe reception toward Estonia and Sweden. Every tool description says so, because a worldwide vessel question routed here would return a confidently empty answer. For coverage beyond the Baltic use `live_ships_in_area` (`vessel-tracking`), which reaches wherever community receivers exist.

### Gotcha worth knowing

The API **requires** `Accept-Encoding: gzip` — requesting identity encoding returns HTTP 406. The pack also sniffs the gzip magic bytes (`0x1f 0x8b`) rather than trusting the `Content-Encoding` header, because Node/undici transparently decompresses while leaving the header in place, and double-decompressing throws `Z_DATA_ERROR`.

## Data sources

- `https://meri.digitraffic.fi/api/ais/v1/locations`
- `https://meri.digitraffic.fi/api/ais/v1/vessels`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "digitraffic-ais": {
      "url": "https://gateway.pipeworx.io/digitraffic-ais/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/digitraffic-ais/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Digitraffic Ais data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
