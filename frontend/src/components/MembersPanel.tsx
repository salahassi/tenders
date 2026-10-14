import { useEffect, useState, type FormEvent } from "react";
import { useApp } from "../lib/store";
import { newInvitationToken } from "../lib/invitations";
import { z } from "zod";
const roles = ["Owner", "Editor", "Reviewer"] as const;
const inviteSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(roles),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expires_at: z.string(),
  revision: z.number().int().positive(),
});
const memberSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(roles),
  active: z.boolean(),
  revision: z.number().int().positive(),
});
type Invite = z.infer<typeof inviteSchema>;
type Member = z.infer<typeof memberSchema>;
export default function MembersPanel() {
  const { backend, state } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<(typeof roles)[number]>("Reviewer"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState("");
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend || !owner) return;
    const read = async (path: string) => {
      const records: unknown[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const response = await backend.request<unknown>(
          `/v1/${path}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page = z
          .object({
            records: z.array(z.unknown()),
            next_cursor: z.uuid().nullable(),
          })
          .parse(response.data);
        records.push(...page.records);
        cursor = page.next_cursor;
        if (cursor && seen.has(cursor))
          throw new Error("Could not load all members. Refresh this page.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return records;
    };
    const [a, b] = await Promise.all([read("invitations"), read("members")]);
    setInvites(z.array(inviteSchema).parse(a));
    setMembers(z.array(memberSchema).parse(b));
  }
  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Could not load users.",
      ),
    );
  }, [backend, owner]);
  if (!backend || !owner) return null;
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setLink("");
    try {
      const { token, token_hash } = await newInvitationToken();
      await backend!.request("/v1/invitations", {
        method: "POST",
        body: { email: email.trim().toLowerCase(), role, token_hash },
        idempotencyKey: crypto.randomUUID(),
      });
      const url = new URL(window.location.href);
      url.search = "?mode=connected";
      url.hash = `/invite/${token}`;
      setLink(url.href);
      setEmail("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Invitation could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke(invite: Invite) {
    setBusy(true);
    setError("");
    try {
      await backend!.request(`/v1/invitations/${invite.id}/revoke`, {
        method: "POST",
        body: { expected_revision: invite.revision },
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not revoke invitation.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function memberChange(
    member: Member,
    changes: Partial<Pick<Member, "role" | "active">>,
  ) {
    setBusy(true);
    setError("");
    try {
      await backend!.request("/v1/memberships/actions", {
        method: "POST",
        body: {
          user_id: member.id,
          role: changes.role ?? member.role,
          active: changes.active ?? member.active,
          reason: "Updated by workspace Owner",
          expected_revision: member.revision,
        },
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update membership.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel admin-section">
      <h2>Users & invitations</h2>
      <p className="admin-help">
        Invite a specific email and choose its permissions. Links expire after 7
        days and require a matching, confirmed email. Copy the link and share it
        with the recipient.
      </p>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      <form onSubmit={invite} className="stack">
        <label className="field">
          Invite email
          <input
            type="email"
            className="input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            disabled={busy}
          />
        </label>
        <label className="field">
          Workspace role
          <select
            className="input"
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
            disabled={busy}
          >
            {roles.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Create invitation
        </button>
      </form>
      {link && (
        <div className="stack" style={{ marginTop: 16 }}>
          <label className="field">
            Invitation link
            <input
              className="input"
              readOnly
              value={link}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button
            className="btn btn-secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(link)
                .catch(() =>
                  setError("Select and copy the invitation link manually."),
                )
            }
          >
            Copy invitation link
          </button>
          <p>
            This link is shown once. If lost, revoke the pending invitation and
            create a new one.
          </p>
        </div>
      )}
      <h3 style={{ marginTop: 24 }}>Members</h3>
      {members.map((member) => (
        <div className="stack" key={member.id} style={{ paddingBlock: 12 }}>
          <strong>{member.email}</strong>
          <div className="row">
            <select
              className="input"
              aria-label={`Role for ${member.email}`}
              disabled={busy}
              value={member.role}
              onChange={(event) =>
                void memberChange(member, {
                  role: event.target.value as Member["role"],
                })
              }
            >
              {roles.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void memberChange(member, { active: !member.active })
              }
            >
              {member.active ? "Disable access" : "Restore access"}
            </button>
          </div>
        </div>
      ))}
      <h3 style={{ marginTop: 24 }}>Invitations</h3>
      {invites.length ? (
        invites.map((invite) => (
          <div key={invite.id} className="stack" style={{ paddingBlock: 12 }}>
            <strong>{invite.email}</strong>
            <span>
              {invite.role} ·{" "}
              {invite.status === "pending" &&
              Date.parse(invite.expires_at) <= Date.now()
                ? "expired"
                : invite.status}{" "}
              · expires {new Date(invite.expires_at).toLocaleDateString()}
            </span>
            {invite.status === "pending" && (
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void revoke(invite)}
              >
                Revoke invitation
              </button>
            )}
          </div>
        ))
      ) : (
        <p>No invitations yet.</p>
      )}
    </section>
  );
}
