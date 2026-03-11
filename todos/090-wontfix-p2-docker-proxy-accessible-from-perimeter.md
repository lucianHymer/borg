---
status: wontfix
priority: p2
issue_id: "090"
tags: [code-review, security, docker]
dependencies: []
---

# docker-proxy accessible from perimeter container, enabling host breakout

## Problem Statement

The docker-proxy service is configured with `-allowfrom=0.0.0.0/0` and all containers share the single `internal` network (docker-compose.yml:129-148). Perimeter has no `DOCKER_PROXY_URL` env var but nothing prevents it from making direct HTTP requests to `http://docker-proxy:2375`. A compromised perimeter agent could create a privileged container with host filesystem bind-mount, achieving full host breakout.

## Findings

- docker-compose.yml:129-148: docker-proxy service uses `-allowfrom=0.0.0.0/0`, accepting connections from any IP on the shared network
- All containers (core, perimeter, infra, dashboard, docker-proxy) share the single `internal` Docker network
- Perimeter container has no `DOCKER_PROXY_URL` environment variable set, but DNS resolution for `docker-proxy` still works from within the `internal` network
- The docker-proxy exposes the Docker daemon socket, allowing container creation, deletion, and exec operations
- A perimeter agent (which handles untrusted external input) could be prompted to make HTTP requests to `http://docker-proxy:2375/containers/create` with a privileged container spec
- This would allow mounting the host filesystem and achieving full host breakout, defeating the zone isolation model

## Proposed Solutions

- Move docker-proxy to a separate `management` network shared only with core, infra, and dashboard containers
- Keep perimeter on the `internal` network only, with no route to the `management` network
- Change `-allowfrom=0.0.0.0/0` to a specific CIDR matching only the management network subnet
- Verify perimeter has no legitimate need to reach docker-proxy and document this as an explicit security boundary

## Acceptance Criteria

- [ ] Perimeter container cannot reach docker-proxy by hostname or IP
- [ ] Core, infra, and dashboard can still reach docker-proxy on the management network
- [ ] docker-proxy `-allowfrom` is restricted to the management network CIDR
- [ ] Network topology is documented in docker-compose.yml with a comment explaining the security boundary

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Shared Docker networks with a privileged proxy are a critical attack surface; perimeter isolation requires network-level separation, not just environment variable omission |
