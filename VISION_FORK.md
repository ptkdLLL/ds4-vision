# ds4-vision — a fork of DwarfStar 4 (ds4.c) for distributed multimodal workloads

This repository is a fork of [antirez/ds4](https://github.com/antirez/ds4) ("DwarfStar 4").
The engine, HTTP server and agent are upstream's; this fork adds a **vision (multimodal)
path built around one hard requirement: prompt-cache reuse must survive images.**

## Why

Agent-style clients resend the full conversation history on every turn. At 260k-500k token
contexts, whether the prefix cache hits is the difference between ~1 s and several minutes per
turn. Image content breaks naive prefix reuse in two ways: image parts can render differently
across turns, and multimodal KV state cannot be rolled back through the compression pipeline.
Upstream deliberately treats image placeholders as untrusted (random nonce markers, no
multimodal disk persistence). This fork instead makes image identity **deterministic and
verifiable**, so a closed client+server deployment can reuse the cache safely.

## What this fork adds

- **Distributed vision** — the vision encoder runs on the coordinator; synthetic image tokens
  are routed through the layer-sliced pipeline (coordinator `0:23`, worker `24:output`) with
  embedding injection and worker-side token acceptance.
- **Deterministic image markers** — every image part renders to a 36-byte marker
  `\x1e DS4_IMAGE_ <sha1(image bytes)[:12] hex> \x1f`, byte-stable across turns. This is the
  anchor of cache reuse (upstream's random nonces defeat visible-text reuse).
- **Byte-level prefix walk + structured binding** — reuse compares the live session render
  with the request render byte-for-byte; markers bind structurally (offset equality) or by
  fingerprint, fail-closed on ambiguity (refuse -> anchor/rebuild, never wrong-image reuse).
- **Multimodal disk snapshots** — image sessions checkpoint to disk with a vision trailer
  (fingerprints + token positions) validated by two-way multiset equality on load.
- **Boundary checkpoints** — snapshots taken at sync-completion boundaries, for sessions whose
  compressor frontier cannot be rolled back.
- **Safety guards in the launcher** — single-machine full-load refusal, GPU wired-limit
  checks, co-residency guards (see `start-cluster-vision.sh`).

## The client half of the contract (`pi-extensions/`)

Cache reuse across images is only realizable with a cooperating client. This repo ships a
[pi](https://github.com/earendil-works/pi) extension package implementing that half:

- **`image-window`** — after an image's viewing turn it replaces the image with the
  deterministic 36-byte marker **in the exact serialization shape of the first send**
  (mirroring the provider's "Attached image(s) from tool result:" extraction for tool-result
  images), so every later turn serializes byte-identically and the prefix stays reusable.
- **`webp-to-png`** — converts webp/gif/bmp files to PNG deterministically before the read
  tool runs (the server parser accepts PNG/JPEG only, and marker identity requires stable
  bytes).

Client contract in one line: *the serialized form of a given history message must be
byte-identical on every turn* — deterministic bytes, canonical replacement shape, marker
replacement at the original offset.

## Status and limitations

- The vision path is experimental and tuned for a specific two-node Apple Silicon deployment
  (one coordinator + one worker, layer-sliced). Interface details may change.
- Model weights are **not** included. "DeepSeek V4 Flash" and its vision encoder are obtained
  separately (see `download_model.sh` and upstream docs).
- Disk-snapshot recovery for image sessions (trailer validation, anchor fallback on
  divergence) has known gaps; treat a server restart as a cache reset for image-heavy
  sessions.

## License

MIT — same as upstream. See `LICENSE` and `NOTICE`.
