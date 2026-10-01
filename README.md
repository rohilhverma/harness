# Local LLM server

From this directory, use the project launcher:

```bash
scripts/llama-server start
scripts/llama-server status
scripts/llama-server stop
scripts/llama-server logs
```

It runs Qwen3-4B-Instruct-2507 Q4_K_M through `llama-server` at
`http://127.0.0.1:8081/v1`. The first start downloads the model; later starts
reuse the Hugging Face cache.

Use a different port when needed:

```bash
LLAMA_PORT=8082 scripts/llama-server start
```
