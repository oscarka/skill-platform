---
name: web-researcher
version: 1.1.0
description: Research any topic by fetching and analyzing live web pages via MCP. Summarizes content, extracts key facts, and compares multiple sources.
metadata:
  openclaw:
    emoji: 🔍
    requires:
      bins: ["npx", "mcporter"]
---

# Web Researcher

This skill lets you research topics by fetching live web pages and analyzing their content.

## Workflow

1.  **Setup (First Time Only)**
    -   Configure the fetch MCP server:
        ```
        mcporter config add fetch --command "npx" --args "-y mcp-fetch-server"
        ```

2.  **Research a Topic**
    -   Use the `fetch_html` MCP tool to retrieve web pages (see exact call syntax below).
    -   Analyze the returned content, extracting key facts and data.
    -   If comparing sources, fetch multiple URLs and synthesize results.

3.  **Output**
    -   Provide a clear, structured summary with key findings.
    -   Include source URLs for reference.
    -   Highlight any conflicting information across sources.

## Tools (via mcporter)

⚠️ **CRITICAL: mcporter call syntax uses `key=value`, NOT `--key value`**

```
# ✅ CORRECT
mcporter call fetch.fetch_html url=https://example.com

# ❌ WRONG - do NOT use --key flags
mcporter call fetch.fetch_html --url https://example.com
```

### fetch_html
Fetches the HTML content of a web page.

- **Args**: `url=<string>` — the URL to fetch
- **Returns**: Raw HTML of the page

**Example:**
```
mcporter call fetch.fetch_html url=https://en.wikipedia.org/wiki/Solar_energy
```

### Handling the HTML response
The tool returns raw HTML. You MUST parse it to extract useful content:
- Look for text within `<p>`, `<h1>`–`<h6>`, `<li>` tags
- Ignore `<script>`, `<style>`, `<nav>`, `<footer>` sections
- Or pipe through python to strip tags:
  ```
  mcporter call fetch.fetch_html url=https://example.com | python3 -c "
  import sys, re
  html = sys.stdin.read()
  text = re.sub(r'<[^>]+>', ' ', html)
  text = re.sub(r'\s+', ' ', text).strip()
  print(text[:3000])
  "
  ```

## Tips

-   Start with Wikipedia or official sites for factual queries.
-   For news, fetch multiple sources to cross-reference.
-   If a URL returns HTTP 403/404, try an alternative source immediately.
-   Wikipedia URLs work well: `https://en.wikipedia.org/wiki/<Topic>`
