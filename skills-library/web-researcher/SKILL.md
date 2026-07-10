---
name: web-researcher
version: 1.0.0
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
    -   Configure the fetch MCP server: `mcporter config add fetch --command "npx" --args "-y @anthropic-ai/mcp-server-fetch"`

2.  **Research a Topic**
    -   When the user asks to research something, use `fetch.fetch` to retrieve relevant web pages.
    -   Analyze and summarize the content.
    -   If comparing sources, fetch multiple URLs and present a comparison.

3.  **Output**
    -   Provide a clear, structured summary with key findings.
    -   Include source URLs for reference.
    -   Highlight any conflicting information across sources.

## Tools (via mcporter)

Call these using `mcporter call fetch.<tool_name> <args>`:

-   **fetch**
    -   Args: `url` (string) - The URL to fetch
    -   Returns: Page content as text/markdown
    -   *Use this to retrieve web page content.*

## Tips

-   Start with well-known sources (Wikipedia, official docs) for factual queries.
-   For news topics, fetch multiple sources to cross-reference.
-   The fetched content is converted to readable text automatically.
-   If a URL returns an error, try an alternative source.
