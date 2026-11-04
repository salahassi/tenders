# Application access to Auth identities

The DigitalOcean application owner already has SELECT on `auth.users` and
`auth.identities`. Auth enables row-level security (RLS), so that grant also needs
an applicable read policy. Hosted metadata from run `41905235686` confirmed that
the policies were missing and the non-superuser application owner could not see
Auth identities.

[`application-auth-read.sql`](../deploy/kubernetes/application-auth-read.sql)
is a platform helper because Auth tables belong to `tdp_app_authadmin`, separately
from the application migrations. It adds only SELECT policies for the existing
application owner. It does not modify users, grants, role membership, ownership
or RLS settings. Browser roles must still lack direct Auth SELECT privileges.
Unknown applicable policies and changed canonical policies cause a failure.

The release manifest binds both this SQL and its Python renderer. Production
release executes it in the same transaction as the application migration batch.
The release takes both Auth relation locks before its first repeatable-read
snapshot and sets timeouts before waiting. A helper invoked after an old snapshot
cannot discover a policy hidden by that snapshot; do not move those early locks.

The managed schema builder uses the same helper inside its reconstruction
transaction. Isolated cloud restore supplies its exact nonce/database comment;
production supplies the permanent managed-database marker. No separate fixture
policy is required. A changed helper requires a new frozen manifest and renewed
cloud qualification. A successful local test is not evidence of production repair.
