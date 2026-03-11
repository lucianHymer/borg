# SDK SDKResultMessage union type: extract usage without branching on subtype

`SDKResultMessage` is a union of success and error subtypes, but both carry the same usage fields. Extract usage after checking `msg.type === "result"` WITHOUT branching on `subtype` — both success and error paths have the data.

```typescript
if (msg.type === "result") {
  // usage is available here regardless of msg.subtype
  const usage = msg.usage; // works for both "success" and "error"
}
```

Easy to miss if you only handle `subtype === "success"` — you'd silently drop usage data from error responses.

The SDK's `ModelUsage` type field names map to our `QueryUsageData` interface with camelCase rename: `total_cost_usd` → `totalCostUSD`, `input_tokens` → `inputTokens`, `cache_creation_input_tokens` → `cacheCreationInputTokens`, etc.

**Related files:** src/queue-processor.ts (collectQueryResponse), src/types.ts (QueryUsageData interface)
