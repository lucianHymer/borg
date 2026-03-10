# Growing preview must show tail, not head

The status preview in queue-processor accumulates text blocks as the SDK response builds (`onTextContent` callback). When truncating to 500 chars, use `slice(-500)` (last 500) not `slice(0, 500)` (first 500). Users want to see where the response *currently is*, not the static beginning.

**Implementation:** `currentPreview = accumulated.length > 500 ? "…" + accumulated.slice(-500) : accumulated;`

This was caught during review after initial implementation used head truncation. The ellipsis prefix signals truncation occurred.

**Related files:** src/queue-processor.ts (onTextContent in processMessage)
