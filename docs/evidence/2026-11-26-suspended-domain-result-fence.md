# Custom-domain results after workspace suspension

## Finding

The scheduler checks suspension when claiming due status pages, but suspension can commit while a DNS lookup is already in flight. Before this change, the subsequent match or failure update did not check suspension. A late failure could increment the stored failure streak or withdraw a domain; a late match could clear a stored failure streak.

## Change

Both result updates now require that no workspace suspension row is visible when the update statement begins. Existing DNS outcome counters retain their meaning: they count observed resolver results, including results that the database correctly declines to apply. The checked timestamp still records the attempt.

This narrows the race. An update whose statement starts before a concurrent suspension commits can still apply; this does not make the suspension transaction atomic with an in-flight DNS check. A DNS lookup already started is not canceled.

## Regression coverage

The PostgreSQL E2E suite inserts a synthetic suspension from inside the resolver callback, after the page has been claimed and before the result update. One case verifies a late failing result does not change verification or failure state; another verifies a late match does not clear a failure streak. The focused test file passed 13/13 on a disposable PostgreSQL 18.7 container. API typecheck and `git diff --check` passed.

No production domains, customer credentials, mail providers, billing, deployment, or external probes were used.
