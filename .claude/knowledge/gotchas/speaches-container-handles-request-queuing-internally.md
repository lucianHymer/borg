# Speaches container handles request queuing internally

The Speaches container (ghcr.io/speaches-ai/speaches) manages sequential request processing internally. No application-level concurrency semaphore is needed for STT/TTS requests. The user confirmed this — just keep sending requests, it handles queuing. This was initially flagged as a review finding (needing a concurrency limit) but was explicitly rejected by the user.

**Related files:** src/audio.ts, docker-compose.yml