# Webhook replay attempt correlation

Each admitted outbound replay now receives an independently generated UUID. Montral returns it with a response and includes it in `replay_outcome_unknown` responses, and sends the same value to the destination in `X-Montral-Replay-Attempt`. This lets an operator distinguish deliberate retries of the same captured event when comparing caller and receiver logs. `X-Montral-Replay` continues to identify the captured event and is stable across attempts.

Captured request headers cannot override either Montral replay header, regardless of header-name casing. The attempt ID is generated only after the durable workspace attempt counter commits. It is transient and is not written to the replay counter, webhook event, audit event, or application logs. The target URL, response, and request body retain their existing privacy behavior.

The identifier correlates requests; it does not show that a remote application accepted or processed a request, prevent duplicate delivery, create exactly-once semantics, or change the counter into billable usage. A timeout or network error remains ambiguous and retains the existing retry warning.

Regression coverage verifies that the destination receives the caller-visible ID, repeated replays get different IDs, captured input cannot spoof the reserved header, and the web API preserves the ID on an ambiguous-outcome error. PostgreSQL route integration runs in hosted CI because this local environment has no `TEST_DATABASE_URL`.
