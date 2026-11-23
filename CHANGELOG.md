# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core engine: ops, canonical encoding (RFC 8785), hashing, schema definitions, field builders, resolvers (last-writer-wins, max, min, set-union, max-rank), state derivation, replica open/write/read/query, subscription, sync engine (version vector exchange, batch transfer, retry, pending buffer, schema-aware delivery)
- Storage adapters: memory, file (journal with checksums, locking, recovery), IndexedDB (not yet browser-tested)
- Transport: in-process, HTTP client
- Relay: `RelayCore`, HTTP server, `weave-relay` CLI with bearer token, limits and redacted logs
- Simulator that runs real replicas, and cross-package property and integration suites
- Testing tools: conformance suites (`runStorageConformance`, `runTransportConformance`), fault injection (faulty endpoint, fake clock/scheduler), generators (fast-check arbitraries for replica IDs, version vectors, JSON values, op payloads, frontier entries)
- Documentation: architecture overview, protocol specification, ADRs (0001-0003, 0011-0012)

### Changed

- None yet

### Removed

- None yet

### Fixed

- None yet