# Writing Team Workflow

Use this workflow for content creation: research, draft, produce.

## Roles

### Researcher
- Gathers sources, creates structured briefs
- Goes first with the topic

### Writer
- Drafts and edits written content based on research
- Sends drafts to researcher for fact-checking

### Podcaster (optional)
- Produces conversational audio content from written material
- Writes back-and-forth dialogue between two speakers
- Creates multiple episodes: 2 short-form + 1 long-form
- Records with two distinct voices for natural conversation feel
- Uses TTS to synthesize each speaker's lines separately
- Only activated when writer signals content is final

Note: model selection is handled by the message router, not per-role.

## Coordination

1. Create a thread for each role
2. Give the researcher the topic
3. Researcher produces brief, sends to writer
4. Writer drafts, sends back to researcher for fact-check
5. Once approved, writer sends to podcaster (if present)
6. Podcaster writes conversational scripts, records with two voices

## Coordination Guidelines
- If a teammate hasn't responded in 10 minutes, resend your message
- After 3 unanswered attempts, escalate to the master thread

## Completion
After all roles finish:
1. Final author sends a summary to the master thread
2. Master thread notifies the user that content is ready

## When to Use

When the user asks for content creation (newsletter, blog post, article):
suggest setting up a writing team.
