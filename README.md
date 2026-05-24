# VkSieve

VkSieve is a pure HTML5 + JavaScript frontend app for locally streaming, filtering, and inspecting large Vulkan API Trace / api_dump text logs.

All file processing runs in the browser. Logs are not uploaded to any backend.

## Local Use

Serve the directory with any static HTTP server:

```sh
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## GitHub Pages

This repository includes a GitHub Actions workflow that publishes the static site to GitHub Pages whenever `main` is pushed.
