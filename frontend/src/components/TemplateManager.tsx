import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import "./commercial.css";
type Section = {
  key: string;
  title: string;
  purpose: string;
  volume: string;
  applicable: boolean;
  rationale: string;
};
type Fixed = { key: string; title: string; body: string; volume: string };
type Template = {
  id?: string;
  revision?: number;
  approved?: boolean;
  title: string;
  language: string;
  volume_mode: string;
  required_sections: Section[];
  fixed_blocks: Fixed[];
  style_config: { accent_color: string; company_name: string; footer: string };
};
export default function TemplateManager() {
  const { backend, runCommand, state, saving } = useApp();
  const [templates, setTemplates] = useState<Template[]>([]),
    [form, setForm] = useState<Template | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend) return;
    try {
      setTemplates(await backend.list<Template>("templates"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load templates.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [backend]);
  async function defaults(language: string) {
    try {
      const { data } = await backend!.request<Template>(
        `/v1/template-defaults?language=${language}`,
      );
      setForm({
        ...data,
        id: undefined,
        revision: undefined,
        title: "",
        language,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load standard sections.",
      );
    }
  }
  async function command(op: string, body: Record<string, unknown>) {
    setError("");
    try {
      await runCommand!(op, body);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save template.");
      return false;
    }
  }
  if (!backend) return null;
  return (
    <section className="panel commercial-panel">
      <h2>Proposal templates</h2>
      <p>
        The standard template covers technical and commercial sections in one
        document. The most recently approved template for the proposal language
        is used for new versions. Fixed legal text is preserved exactly. Buyer
        instructions can require separate volumes.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {loading && <p>Loading templates…</p>}
      {templates.map((t) => (
        <div className="commercial-card" key={t.id}>
          <strong>{t.title}</strong>
          <p>
            {t.language === "ar" ? "Arabic" : "English"} · {t.volume_mode} ·
            revision {t.revision} ·{" "}
            {t.approved ? "Owner approved" : "Needs approval"}
          </p>
          {owner && (
            <>
              <Button
                disabled={saving}
                onClick={() => setForm(structuredClone(t))}
              >
                Edit template
              </Button>
              {!t.approved && (
                <Button
                  disabled={saving}
                  onClick={() =>
                    command("template.approve", {
                      id: t.id,
                      expected_revision: t.revision,
                    })
                  }
                >
                  Approve template
                </Button>
              )}
            </>
          )}
        </div>
      ))}
      {!loading && !templates.length && (
        <p>
          No custom templates. New proposals use the standard professional
          structure.
        </p>
      )}
      {owner && (
        <>
          <Button disabled={saving} onClick={() => defaults("en")}>
            New English template
          </Button>
          <Button disabled={saving} onClick={() => defaults("ar")}>
            New Arabic template
          </Button>
        </>
      )}
      {owner && form && (
        <fieldset disabled={saving}>
          <Field label="Template name">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Document organization">
            <select
              value={form.volume_mode}
              onChange={(e) =>
                setForm({ ...form, volume_mode: e.target.value })
              }
            >
              <option value="combined">
                Combined technical and commercial
              </option>
              <option value="separate">
                Separate technical and financial volumes
              </option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Company display name (verified public name only)">
              <input
                value={form.style_config.company_name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    style_config: {
                      ...form.style_config,
                      company_name: e.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Accent color">
              <input
                type="color"
                value={form.style_config.accent_color}
                onChange={(e) =>
                  setForm({
                    ...form,
                    style_config: {
                      ...form.style_config,
                      accent_color: e.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Footer">
              <input
                value={form.style_config.footer}
                onChange={(e) =>
                  setForm({
                    ...form,
                    style_config: {
                      ...form.style_config,
                      footer: e.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
          <h3>Required sections</h3>
          {form.required_sections.map((s, i) => (
            <details className="commercial-card" key={s.key}>
              <summary>
                {s.title} · {s.applicable ? "Included" : "Not applicable"}
              </summary>
              <Field label="Section title">
                <input
                  value={s.title}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      required_sections: form.required_sections.map((v, j) =>
                        i === j ? { ...v, title: e.target.value } : v,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="Purpose and writing guidance">
                <textarea
                  value={s.purpose}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      required_sections: form.required_sections.map((v, j) =>
                        i === j ? { ...v, purpose: e.target.value } : v,
                      ),
                    })
                  }
                />
              </Field>
              <label>
                <input
                  type="checkbox"
                  checked={s.applicable}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      required_sections: form.required_sections.map((v, j) =>
                        i === j ? { ...v, applicable: e.target.checked } : v,
                      ),
                    })
                  }
                />{" "}
                Include this section
              </label>
              {!s.applicable && (
                <Field label="Owner rationale for non-applicability">
                  <textarea
                    value={s.rationale}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        required_sections: form.required_sections.map((v, j) =>
                          i === j ? { ...v, rationale: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </Field>
              )}
            </details>
          ))}
          <h3>Fixed legal and policy text</h3>
          <p>
            Include only approved wording suitable for this shared trial. These
            blocks are added without AI rewriting.
          </p>
          {form.fixed_blocks.map((b, i) => (
            <div className="commercial-card" key={b.key}>
              <Field label="Fixed block title">
                <input
                  value={b.title}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      fixed_blocks: form.fixed_blocks.map((v, j) =>
                        i === j ? { ...v, title: e.target.value } : v,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="Exact approved wording">
                <textarea
                  dir="auto"
                  value={b.body}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      fixed_blocks: form.fixed_blocks.map((v, j) =>
                        i === j ? { ...v, body: e.target.value } : v,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="Volume">
                <select
                  value={b.volume}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      fixed_blocks: form.fixed_blocks.map((v, j) =>
                        i === j ? { ...v, volume: e.target.value } : v,
                      ),
                    })
                  }
                >
                  <option value="technical">Technical</option>
                  <option value="financial">Financial</option>
                  <option value="shared">Both</option>
                </select>
              </Field>
              <Button
                onClick={() =>
                  setForm({
                    ...form,
                    fixed_blocks: form.fixed_blocks.filter((_, j) => i !== j),
                  })
                }
              >
                Remove fixed block
              </Button>
            </div>
          ))}
          <Button
            disabled={form.fixed_blocks.length >= 20}
            onClick={() =>
              setForm({
                ...form,
                fixed_blocks: [
                  ...form.fixed_blocks,
                  {
                    key: `fixed_${crypto.randomUUID().replaceAll("-", "")}`,
                    title: "",
                    body: "",
                    volume: "shared",
                  },
                ],
              })
            }
          >
            Add fixed block
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              const {
                id,
                revision,
                title,
                language,
                volume_mode,
                required_sections,
                fixed_blocks,
                style_config,
              } = form;
              if (
                await command("template.save", {
                  ...(id ? { id } : {}),
                  expected_revision: revision || 0,
                  title,
                  language,
                  volume_mode,
                  required_sections,
                  fixed_blocks,
                  style_config,
                })
              )
                setForm(null);
            }}
          >
            Save for approval
          </Button>
          <Button onClick={() => setForm(null)}>Cancel edit</Button>
        </fieldset>
      )}
    </section>
  );
}
