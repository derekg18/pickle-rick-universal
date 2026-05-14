Return the skeleton-only cloud provisioning safety contract.

# /nimbus

Return a typed JSON-style skeleton for cloud provisioning and cloud-cost planning. v1 is intentionally skeleton-only: it returns `status: not_implemented`, `artifact`, and `skeleton`, with `skeleton.started: false` and an empty `artifact.executed_actions` list.

## Usage

```bash
/nimbus [workspace] [--env <name>] [--cloud-cost] [--cloud-provision]
```

Cloud-cost and cloud-provisioning flags return `status: needs_followup` unless explicitly confirmed. Confirmation does not provision cloud resources in v1; it only acknowledges that the caller has reviewed the typed safety boundary.
