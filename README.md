# @pipeworx/digitraffic-ais

Live vessel positions in Finnish and Baltic waters, from Fintraffic's AIS receivers. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Digitraffic Ais data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
