# Source register and preservation

User states full legal permission to copy/rebrand the three named sources. Repository license files are still retained to meet their terms and support transparent provenance.

| Montral source snapshot | Origin | License | Upstream commit | File count |
|---|---|---|---|---|
| `vendor/montral-core` | https://github.com/becoolme/openuptime | MIT | `8dcba0780907c70c3225ec8e6891d73ec823352a` | 431 |
| `vendor/montral-cloud-probes` | https://github.com/lyc8503/UptimeFlare | Apache-2.0 | `8035521268a54222959eaf720c82f530e755b6bb` | 72 |
| `vendor/montral-webhooks-legacy` | https://github.com/webhooksite/webhook.site | MIT | `96b7b4275b4481eedd8a3f052aa44642eb3b4ae2` | 135 |

All files were sourced by `git archive HEAD` from shallow upstream clones, not manual cherry-picking. Exact upstream legal files reside in the corresponding source snapshot directories. Non-Git history is not part of the snapshots; Git commit SHA identifies each pin.

**Important:** Snapshot names reflect Montral component roles; original source identifiers, copyrights, license text and historical docs remain unaltered inside `vendor/`. This is deliberate for compliance. Only active product code and user-facing documentation should be rebranded.

The Webhook.site snapshot pins an old Laravel 5.4/PHP 7.1-era stack. It is a historical donor, not safe production hosting infrastructure.

Do not treat the upstream proprietary hosted billing add-ons as part of any imported open source repository.
